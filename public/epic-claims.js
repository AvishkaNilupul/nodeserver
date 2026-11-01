/* Claims tab of /epic-accounts.html (layout contract: docs/EPIC-PAGE-UI.md).
   Stat tiles, the free-game claims card and the compact account list with
   Deliver / Buyer sessions / Mark sold / Remove. toast(), load() and closeModal()
   stay global: the other tab scripts and the modal markup call them. */

var $ = function (id) {
  return document.getElementById(id);
};
function toast(msg, err) {
  var t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(
    function () {
      t.className = "toast";
    },
    err ? 6000 : 3500,
  );
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
async function api(url, opts) {
  var r = await fetch(
    url,
    Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, opts || {}),
  );
  var j = await r.json().catch(function () {
    return {};
  });
  if (!r.ok || j.success === false) throw new Error(j.message || "HTTP " + r.status);
  return j;
}

var accounts = [];
var claimsLoaded = false;
// Set by load() from the server: Epic's HTTP 429 pause, if one is on.
var claimPausedUntil = null;
var PAGE = 20;
var claimsView = { filter: "all", q: "", sort: "attention", limit: PAGE };
var openRows = new Set();
var claimableCount = 0;
var claimBatch = null;
try {
  var savedSort = localStorage.getItem("epic.claims.sort");
  if (savedSort) claimsView.sort = savedSort;
} catch (e) {}

// ---- small helpers -------------------------------------------------------
function money(n) {
  return "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function accLabel(a) {
  return a.label || a.displayName || a.accountId;
}
function missingOf(a) {
  return a.missingLive || [];
}
function lockedOf(a) {
  return a.regionLocked || [];
}
function needsLogin(a) {
  return a.status !== "ok";
}
function createdAt(a) {
  var t = new Date(a.createdAt).getTime();
  return isNaN(t) ? 0 : t;
}
function byId(id) {
  return accounts.find(function (a) {
    return String(a._id) === String(id);
  });
}
function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many || one + "s");
}

var countrySources = {
  "proxy-ip": "signup IP",
  "recorded-account-country": "account country",
};
function regionChip(a) {
  if (!a.country) return "";
  return (
    '<span class="cc" title="Region: ' +
    esc(a.country) +
    " (from " +
    esc(countrySources[a.countrySource] || a.countrySource || "account details") +
    ')">' +
    esc(a.country) +
    "</span>"
  );
}
function shortWhen(d) {
  var t = new Date(d);
  return isNaN(t) ? "" : t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function whenLabel(d) {
  var t = new Date(d),
    now = new Date();
  if (isNaN(t)) return "";
  return t.toDateString() === now.toDateString()
    ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : shortWhen(t);
}
// "" when claims may run, else the time Epic's pause ends.
function pauseLabel() {
  return claimPausedUntil && new Date(claimPausedUntil) > new Date() ? whenLabel(claimPausedUntil) : "";
}
function lastTryHtml(t) {
  if (!t) return "";
  return (
    '<span class="game-note">Last try ' +
    esc(shortWhen(t.at)) +
    ": " +
    esc(String(t.status || "").replace(/_/g, " ")) +
    (t.error ? " · " + esc(t.error) : "") +
    "</span>"
  );
}

// ---- filtering and sorting -----------------------------------------------
var FILTERS = [
  ["all", "All", function () {
    return true;
  }],
  ["claim", "To claim", function (a) {
    return !a.sold && missingOf(a).length > 0;
  }],
  ["login", "Needs login", function (a) {
    return !a.sold && needsLogin(a);
  }],
  ["region", "Region locked", function (a) {
    return lockedOf(a).length > 0;
  }],
  ["sold", "Sold", function (a) {
    return !!a.sold;
  }],
];
// Needs login, then games to claim, then region locks, then the rest; sold last.
function rank(a) {
  if (a.sold) return 4;
  if (needsLogin(a)) return 0;
  if (missingOf(a).length) return 1;
  if (lockedOf(a).length) return 2;
  return 3;
}
function matches(a, q) {
  if (!q) return true;
  var hay = [a.label, a.displayName, a.accountId, a.country]
    .concat((a.library || []).map(function (g) {
      return g.title;
    }))
    .concat(missingOf(a).concat(lockedOf(a)).map(function (m) {
      return m.title;
    }))
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every(function (w) {
    return hay.indexOf(w) >= 0;
  });
}
function sortRows(rows) {
  var s = claimsView.sort;
  return rows.slice().sort(function (x, y) {
    if (s === "oldest") return createdAt(x) - createdAt(y);
    if (s === "value") return (y.libraryValueUsd || 0) - (x.libraryValueUsd || 0) || createdAt(y) - createdAt(x);
    if (s === "attention") {
      var r = rank(x) - rank(y);
      if (r) return r;
    }
    return createdAt(y) - createdAt(x);
  });
}

// ---- rendering -----------------------------------------------------------
function stat(label, value, hint, tone) {
  return (
    '<div class="ep-stat' +
    (tone ? " is-" + tone : "") +
    '"><span class="ep-stat-label">' +
    esc(label) +
    '</span><span class="ep-stat-value">' +
    esc(value) +
    '</span><span class="ep-stat-hint">' +
    esc(hint) +
    "</span></div>"
  );
}

function renderStats() {
  var live = accounts.filter(function (a) {
    return !a.sold;
  });
  var sold = accounts.length - live.length;
  var login = 0,
    claimable = 0,
    claimAccounts = 0,
    stuck = 0,
    locks = 0,
    games = 0,
    value = 0;
  live.forEach(function (a) {
    var n = missingOf(a).length;
    if (needsLogin(a)) {
      login++;
      stuck += n;
    } else {
      claimable += n;
      if (n) claimAccounts++;
    }
    locks += lockedOf(a).length;
    games += a.libraryCount || 0;
    value += a.libraryValueUsd || 0;
  });
  claimableCount = claimable;
  var claimHint = claimable ? "on " + plural(claimAccounts, "account") : "Everything free is claimed";
  if (stuck) claimHint += " · " + stuck + " more wait for a login";
  if (locks) claimHint += " · " + locks + " region-locked";
  $("claimStats").innerHTML =
    stat("Accounts", accounts.length, live.length - login + " connected" + (sold ? " · " + sold + " sold" : "")) +
    stat("Games to claim", claimable, claimHint, claimable ? "warn" : "ok") +
    stat("Need login", login, login ? "Reconnect them with Add account" : "All connected", login ? "error" : "ok") +
    stat("Library value", money(value), plural(games, "game") + " on unsold accounts");
  EpicTabs.badge("claims", claimable || "", claimable ? "warn" : "");
}

function renderFilters() {
  $("accFilters").innerHTML = FILTERS.map(function (f) {
    var n = accounts.filter(f[2]).length;
    var on = claimsView.filter === f[0];
    if (f[0] !== "all" && !n && !on) return "";
    return (
      '<button type="button" class="ep-chip' +
      (on ? " is-on" : "") +
      '" data-filter="' +
      f[0] +
      '" aria-pressed="' +
      on +
      '">' +
      esc(f[1]) +
      ' <span class="ep-chip-count">' +
      n +
      "</span></button>"
    );
  }).join("");
}

function statusHtml(a) {
  if (!needsLogin(a)) return '<span class="ep-badge is-ok"><i class="ep-dot is-ok"></i>Connected</span>';
  var err = a.lastError ? String(a.lastError) : "";
  return (
    '<span class="ep-badge is-error"><i class="ep-dot is-error"></i>Needs login</span>' +
    (err ? '<div class="acc-err" title="' + esc(err) + '">' + esc(err) + "</div>" : "")
  );
}

var pendingClaimLinks = new Set();
function missingHtml(a) {
  var paused = pauseLabel();
  var busy = pendingClaimLinks.has(String(a._id));
  var rows = missingOf(a).map(function (m) {
    var b = paused
      ? '<button type="button" class="btn btn-sm" disabled title="Epic answered HTTP 429. Claims resume on their own.">Paused until ' +
        esc(paused) +
        "</button>"
      : busy
        ? '<button type="button" class="btn btn-sm" disabled><span class="spin"></span>Claiming…</button>'
        : '<button type="button" class="btn btn-sm" data-act="claim" data-offer="' + esc(m.offerId) + '">Claim</button>';
    return '<div class="game-row"><span>' + esc(m.title) + lastTryHtml(m.lastTry) + "</span>" + b + "</div>";
  });
  lockedOf(a).forEach(function (m) {
    rows.push(
      '<div class="game-row region-lock"><span>' +
        esc(m.title) +
        '<span class="game-note">' +
        (m.reason === "epic" ? "Epic refused this account" : "Epic refused another " + esc(m.country) + " account") +
        '</span></span><span class="ep-badge is-error">Region locked' +
        (m.country ? " · " + esc(m.country) : "") +
        "</span></div>",
    );
  });
  return rows.length ? rows.join("") : '<span class="acc-allgood">All claimed</span>';
}

function detailHtml(a) {
  var id = String(a._id);
  var games = (a.library || []).slice().sort(function (x, y) {
    return (y.priceUsd || 0) - (x.priceUsd || 0);
  });
  var lib = games.length
    ? '<ul class="acc-games">' +
      games
        .map(function (g) {
          return "<li><span>" + esc(g.title) + "</span><span>" + (g.priceUsd ? money(g.priceUsd) : "") + "</span></li>";
        })
        .join("") +
      "</ul>"
    : '<div class="muted">No games yet.</div>';
  var kv = [
    ["Epic name", a.displayName],
    ["Epic ID", a.accountId],
    [
      "Region",
      a.country
        ? a.country + " (from " + (countrySources[a.countrySource] || a.countrySource || "account details") + ")"
        : "",
    ],
    ["Added", a.createdAt ? shortWhen(a.createdAt) : ""],
    ["Library checked", a.lastCheckedAt ? shortWhen(a.lastCheckedAt) : ""],
  ].filter(function (r) {
    return r[1];
  });
  return (
    '<tr class="acc-detail" id="acc-d-' +
    esc(id) +
    '" data-id="' +
    esc(id) +
    '"><td colspan="6"><div class="acc-detail-grid"><section><h4>Library · ' +
    plural(a.libraryCount || 0, "game") +
    " · " +
    money(a.libraryValueUsd) +
    "</h4>" +
    lib +
    '</section><section><h4>Account</h4><dl class="ep-kv">' +
    kv
      .map(function (r) {
        return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>";
      })
      .join("") +
    "</dl>" +
    (needsLogin(a) && a.lastError ? '<div class="ep-note is-error" style="margin-top:10px">' + esc(a.lastError) + "</div>" : "") +
    '</section></div><div class="acc-actions">' +
    (a.sold ? "" : '<button type="button" class="btn btn-sm btn-primary" data-act="deliver">Deliver</button>') +
    '<button type="button" class="btn btn-sm" data-act="sessions">Buyer sessions</button>' +
    '<button type="button" class="btn btn-sm" data-act="sold">' +
    (a.sold ? "Unmark sold" : "Mark sold") +
    "</button>" +
    '<button type="button" class="btn btn-sm" data-act="details">Edit details</button>' +
    '<button type="button" class="btn btn-sm btn-danger" data-act="remove">Remove</button>' +
    "</div></td></tr>"
  );
}

function rowHtml(a) {
  var id = String(a._id),
    open = openRows.has(id);
  return (
    '<tr class="acc-row' +
    (a.sold ? " is-sold" : "") +
    (open ? " is-open" : "") +
    '" data-id="' +
    esc(id) +
    '"><td class="c-toggle"><button type="button" class="acc-twisty" data-act="toggle" aria-expanded="' +
    open +
    '" aria-controls="acc-d-' +
    esc(id) +
    '" title="' +
    (open ? "Hide details" : "Show details") +
    '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></td>' +
    '<td class="c-acct"><div class="acc-name"><b title="' +
    esc(accLabel(a)) +
    '">' +
    esc(accLabel(a)) +
    "</b>" +
    regionChip(a) +
    (a.sold ? '<span class="ep-badge">Sold</span>' : "") +
    '</div><div class="acc-sub">' +
    esc(a.displayName && a.displayName !== accLabel(a) ? a.displayName : "") +
    '</div></td><td class="c-status" data-label="Status">' +
    statusHtml(a) +
    '</td><td class="c-lib is-right ep-num" data-label="Games">' +
    (a.libraryCount || 0) +
    '</td><td class="c-value is-right ep-num" data-label="Value">' +
    money(a.libraryValueUsd) +
    '</td><td class="c-missing" data-label="Free games">' +
    missingHtml(a) +
    "</td></tr>" +
    (open ? detailHtml(a) : "")
  );
}

function renderList() {
  var f =
    FILTERS.find(function (x) {
      return x[0] === claimsView.filter;
    }) || FILTERS[0];
  var q = claimsView.q.trim().toLowerCase();
  var rows = sortRows(
    accounts.filter(function (a) {
      return f[2](a) && matches(a, q);
    }),
  );
  $("accCount").textContent = accounts.length ? plural(accounts.length, "account") : "";
  if (!accounts.length) {
    $("list").innerHTML =
      '<div class="ep-empty"><b>No accounts yet</b><span>Connect your first Epic account with Add account.</span></div>';
    return;
  }
  if (!rows.length) {
    $("list").innerHTML =
      '<div class="ep-empty"><b>No accounts match</b><span>Try another search or filter.</span><button type="button" class="btn btn-sm" data-clear="1">Show all accounts</button></div>';
    return;
  }
  var shown = rows.slice(0, claimsView.limit);
  var html =
    '<div class="ep-table-wrap acc-wrap"><table class="acc-table ep-table"><thead><tr><th class="c-toggle"></th><th>Account</th><th>Status</th><th class="is-right">Games</th><th class="is-right">Value</th><th>Free games</th></tr></thead><tbody>' +
    shown.map(rowHtml).join("") +
    "</tbody></table></div>";
  if (rows.length > shown.length) {
    html +=
      '<div class="ep-more"><span>Showing ' +
      shown.length +
      " of " +
      rows.length +
      '</span><span class="row"><button type="button" class="btn btn-sm" data-more="page">Show ' +
      Math.min(PAGE, rows.length - shown.length) +
      ' more</button><button type="button" class="btn btn-sm btn-ghost" data-more="all">Show all</button></span></div>';
  }
  $("list").innerHTML = html;
}

function render() {
  renderStats();
  renderFilters();
  renderList();
  if (claimBatch) claimBatch.redraw();
}

function renderStatus(st, ac) {
  var parts = [];
  if (st) {
    parts.push(st.lastRun ? "Last sync <b>" + esc(shortWhen(st.lastRun)) + "</b>" : "Not synced yet");
    parts.push(
      st.nextRunAt ? "Next run <b>" + esc(shortWhen(st.nextRunAt)) + "</b>" : "Auto-sync every " + esc(st.intervalHours) + " h",
    );
  }
  var badge = $("autoClaimBadge");
  if (ac) {
    if (ac.rateLimitedUntil) {
      badge.className = "ep-badge is-warn";
      badge.textContent = "Paused until " + whenLabel(ac.rateLimitedUntil);
      badge.title = "Epic answered HTTP 429 (its purchase limit). Claims resume on their own.";
    } else if (ac.enabled) {
      badge.className = "ep-badge is-ok";
      badge.textContent = "Auto-claim on";
      badge.title = "";
      parts.push("<b>" + esc(ac.todayCount || 0) + "/" + esc(ac.dailyCap) + "</b> checkouts today");
      if (ac.nextCheckoutAt && new Date(ac.nextCheckoutAt) > new Date())
        parts.push("Next checkout after <b>" + esc(whenLabel(ac.nextCheckoutAt)) + "</b>");
    } else {
      badge.className = "ep-badge";
      badge.textContent = "Auto-claim off";
      badge.title = "";
    }
    badge.hidden = false;
  }
  $("statusLine").innerHTML = parts
    .map(function (p) {
      return "<span>" + p + "</span>";
    })
    .join("");
}

var pauseReload = null;
async function load() {
  try {
    var j = await api("/api/epic/accounts");
    accounts = j.accounts || [];
    claimsLoaded = true;
    $("redirectLink").href = j.redirectUrl;
    claimPausedUntil = (j.autoClaim && j.autoClaim.rateLimitedUntil) || null;
    renderStatus(j.status, j.autoClaim);
    render();
    // Bring the Claim buttons back once Epic's pause ends.
    clearTimeout(pauseReload);
    var left = claimPausedUntil ? new Date(claimPausedUntil) - Date.now() : 0;
    if (left > 0) pauseReload = setTimeout(load, Math.min(left + 5000, 2147483647));
  } catch (e) {
    if (claimsLoaded) toast("Refresh failed: " + e.message, true);
    else
      $("list").innerHTML =
        '<div class="ep-empty"><b>Could not load the accounts</b><span>' +
        esc(e.message) +
        '</span><button type="button" class="btn btn-sm" data-retry="1">Try again</button></div>';
  }
}

// ---- account actions -----------------------------------------------------
window.claimNow = async function (id, offerId) {
  if (pendingClaimLinks.has(id)) return;
  pendingClaimLinks.add(id);
  renderList();
  toast("Claim running on the Mac…");
  try {
    var j = await api("/api/epic/accounts/" + id + "/auto-claim", {
      method: "POST",
      body: JSON.stringify({ offerId: offerId }),
    });
    var result = j.result || {};
    if (result.status === "rate_limited") {
      claimPausedUntil = result.retryAt || claimPausedUntil;
      await load();
      throw new Error(
        "Epic is limiting checkouts (HTTP 429). Claims resume on their own" +
          (pauseLabel() ? " after " + pauseLabel() : "") +
          ".",
      );
    }
    if (result.status === "spacing") {
      throw new Error("Checkouts are spaced out to avoid Epic's limit. Try again after " + whenLabel(result.retryAt) + ".");
    }
    if (!["claimed", "already_owned"].includes(result.status)) {
      throw new Error(result.error || result.status || "Claim did not finish");
    }
    if (result.tokenNeedsLogin) throw new Error("Game claimed; account needs reconnection.");
    toast(result.status === "already_owned" ? "Already in the library." : "Claimed and verified in the library.");
    await load();
  } catch (e) {
    toast("Claim: " + e.message, true);
  } finally {
    pendingClaimLinks.delete(id);
    renderList();
  }
};

window.toggleSold = async function (id, sold) {
  try {
    await api("/api/epic/accounts/" + id, { method: "PATCH", body: JSON.stringify({ sold: sold }) });
    load();
  } catch (e) {
    toast(e.message, true);
  }
};

window.delAcc = async function (id) {
  if (!confirm("Remove this account from tracking?")) return;
  try {
    await api("/api/epic/accounts/" + id, { method: "DELETE" });
    openRows.delete(String(id));
    load();
  } catch (e) {
    toast(e.message, true);
  }
};

function toggleRow(id) {
  if (openRows.has(id)) openRows.delete(id);
  else openRows.add(id);
  renderList();
}

$("list").addEventListener("click", function (e) {
  var more = e.target.closest("[data-more]");
  if (more) {
    claimsView.limit = more.getAttribute("data-more") === "all" ? Infinity : claimsView.limit + PAGE;
    renderList();
    return;
  }
  if (e.target.closest("[data-clear]")) {
    claimsView.filter = "all";
    claimsView.q = "";
    $("accSearch").value = "";
    renderFilters();
    renderList();
    return;
  }
  if (e.target.closest("[data-retry]")) {
    load();
    return;
  }
  var row = e.target.closest("tr[data-id]");
  if (!row) return;
  var id = row.getAttribute("data-id");
  var a = byId(id);
  var b = e.target.closest("button, a, input, select, textarea, label");
  if (!b) {
    // A click anywhere on the summary row opens it, unless text is being selected.
    if (row.classList.contains("acc-row") && !String(window.getSelection() || "")) toggleRow(id);
    return;
  }
  var act = b.getAttribute("data-act");
  if (!a || !act) return;
  if (act === "toggle") toggleRow(id);
  else if (act === "claim") claimNow(id, b.getAttribute("data-offer"));
  else if (act === "deliver") openDeliver(id, accLabel(a));
  else if (act === "sessions") openSessions(id, accLabel(a));
  else if (act === "sold") toggleSold(id, !a.sold);
  else if (act === "remove") delAcc(id);
  else if (act === "details") location.hash = "#details?account=" + encodeURIComponent(id);
});

$("accFilters").addEventListener("click", function (e) {
  var b = e.target.closest("[data-filter]");
  if (!b) return;
  claimsView.filter = b.getAttribute("data-filter");
  claimsView.limit = PAGE;
  renderFilters();
  renderList();
});

var searchTimer = null;
$("accSearch").addEventListener("input", function () {
  clearTimeout(searchTimer);
  var v = this.value;
  searchTimer = setTimeout(function () {
    claimsView.q = v;
    claimsView.limit = PAGE;
    renderList();
  }, 150);
});

$("accSort").value = claimsView.sort;
if ($("accSort").value !== claimsView.sort) claimsView.sort = $("accSort").value = "attention";
$("accSort").addEventListener("change", function () {
  claimsView.sort = this.value;
  claimsView.limit = PAGE;
  try {
    localStorage.setItem("epic.claims.sort", this.value);
  } catch (e) {}
  renderList();
});

$("btnAddToggle").addEventListener("click", function () {
  var box = $("addBox");
  box.hidden = !box.hidden;
  this.setAttribute("aria-expanded", String(!box.hidden));
  this.classList.toggle("btn-primary", !box.hidden);
  if (!box.hidden) $("addLabel").focus();
});

// ---- Buyer mail delivery flow ----------------------------------------------
var deliverState = { accountId: "", label: "" };

function openModal(id) {
  $(id).classList.add("show");
}
window.closeModal = function (id) {
  $(id).classList.remove("show");
};

window.openDeliver = function (accountId, label) {
  deliverState = { accountId: accountId, label: label };
  $("deliverSub").innerHTML =
    "Minting access for <b>" +
    esc(label) +
    "</b>. The buyer signs in at <code>/mail/</code> and sees only mail from Epic received after this moment. The password shown here is one-shot — copy it.";
  $("deliverForm").style.display = "";
  $("deliverResult").style.display = "none";
  $("dMarketplace").value = "";
  $("dOrderRef").value = "";
  $("dDays").value = "7";
  $("dNote").value = "";
  $("dForce").checked = false;
  openModal("deliverModal");
};

$("dMintBtn").addEventListener("click", async function () {
  var b = this;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Minting…';
  try {
    var j = await api("/api/epic/accounts/" + deliverState.accountId + "/buyer-session", {
      method: "POST",
      body: JSON.stringify({
        marketplace: $("dMarketplace").value || "",
        orderRef: $("dOrderRef").value.trim(),
        days: Number($("dDays").value) || 7,
        note: $("dNote").value.trim(),
        force: $("dForce").checked,
      }),
    });
    $("rLogin").textContent = j.loginUrl;
    $("rEmail").textContent = j.session.inboxAddress;
    $("rPassword").textContent = j.buyerPassword;
    $("rExpires").textContent = new Date(j.session.expiresAt).toLocaleString();
    $("rTemplate").value = j.deliveryTemplate;
    $("deliverForm").style.display = "none";
    $("deliverResult").style.display = "";
    toast("Session minted — copy the password now.");
  } catch (e) {
    toast(e.message, true);
  }
  b.disabled = false;
  b.textContent = "Mint delivery";
});

$("rCopyBtn").addEventListener("click", async function () {
  try {
    await navigator.clipboard.writeText($("rTemplate").value);
    toast("Delivery message copied.");
  } catch (e) {
    $("rTemplate").select();
    document.execCommand("copy");
    toast("Delivery message copied.");
  }
});

// ---- Sessions list -----------------------------------------------------------
var sessionsState = { accountId: "", label: "" };

window.openSessions = async function (accountId, label) {
  sessionsState = { accountId: accountId, label: label };
  $("sessionsSub").innerHTML = "Last 25 sessions for <b>" + esc(label) + "</b>.";
  $("sessionsList").innerHTML = '<div class="muted">Loading…</div>';
  openModal("sessionsModal");
  try {
    var j = await api("/api/epic/accounts/" + accountId + "/buyer-sessions");
    renderSessions(j.sessions || []);
  } catch (e) {
    $("sessionsList").innerHTML = '<div class="muted">Failed to load: ' + esc(e.message) + "</div>";
  }
};

function sessionPill(s) {
  var now = Date.now();
  if (s.revokedAt)
    return '<span class="pill pill-revoked">revoked' + (s.revokedReason ? " · " + esc(s.revokedReason) : "") + "</span>";
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= now) return '<span class="pill pill-expired">expired</span>';
  return '<span class="pill pill-live">live</span>';
}

function renderSessions(rows) {
  if (!rows.length) {
    $("sessionsList").innerHTML = '<div class="muted">No sessions yet for this account.</div>';
    return;
  }
  $("sessionsList").innerHTML = rows
    .map(function (s) {
      var views = s.viewCount
        ? s.viewCount + " view(s) · last " + (s.lastViewAt ? new Date(s.lastViewAt).toLocaleString() : "—")
        : "never viewed";
      var meta = (s.marketplace ? esc(s.marketplace) : "manual") + (s.orderRef ? " · " + esc(s.orderRef) : "");
      return (
        '<div class="sess-row"><div><b>' +
        esc(s.inboxAddress) +
        "</b><div class='muted'>" +
        meta +
        " · created " +
        new Date(s.createdAt).toLocaleString() +
        " · expires " +
        new Date(s.expiresAt).toLocaleString() +
        "</div><div class='muted'>" +
        views +
        "</div></div><div>" +
        sessionPill(s) +
        "</div><div>" +
        (s.revokedAt
          ? ""
          : '<button class="btn btn-sm btn-danger" onclick="revokeSession(\'' + esc(s.id) + "')\">Revoke</button>") +
        "</div></div>"
      );
    })
    .join("");
}

window.revokeSession = async function (sessionId) {
  if (!confirm("Revoke this buyer session? The buyer loses mail access.")) return;
  try {
    await api("/api/epic/buyer-sessions/" + sessionId + "/revoke", {
      method: "POST",
      body: JSON.stringify({ reason: "manual" }),
    });
    toast("Session revoked.");
    if (sessionsState.accountId) openSessions(sessionsState.accountId, sessionsState.label);
  } catch (e) {
    toast(e.message, true);
  }
};

// Close modals on a backdrop click or Escape.
["deliverModal", "sessionsModal"].forEach(function (id) {
  $(id).addEventListener("click", function (e) {
    if (e.target === this) closeModal(id);
  });
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  ["deliverModal", "sessionsModal"].forEach(function (id) {
    if ($(id).classList.contains("show")) closeModal(id);
  });
});

$("btnAdd").addEventListener("click", async function () {
  var code = $("addCode").value.trim();
  var m = code.match(/[0-9a-f]{32}/i);
  if (m) code = m[0]; // allow pasting the whole JSON blob
  var b = this;
  b.disabled = true;
  try {
    await api("/api/epic/accounts", {
      method: "POST",
      body: JSON.stringify({ code: code, label: $("addLabel").value.trim() }),
    });
    $("addCode").value = "";
    toast("Account added — library sync started.");
    setTimeout(load, 4000);
    load();
  } catch (e) {
    toast(e.message, true);
  }
  b.disabled = false;
});

$("btnSync").addEventListener("click", async function () {
  var b = this;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Syncing…';
  try {
    var j = await api("/api/epic/accounts/sync", { method: "POST" });
    toast(
      "Synced " +
        j.counts.synced +
        "/" +
        j.counts.accounts +
        " account(s), " +
        j.counts.pendingClaims +
        " pending claim(s).",
    );
  } catch (e) {
    toast("Sync failed: " + e.message, true);
  }
  b.disabled = false;
  b.textContent = "Sync all now";
  load();
});
$("btnRefresh").addEventListener("click", load);

claimBatch = initEpicClaimBatch({
  api: api,
  load: load,
  toast: toast,
  pausedUntil: pauseLabel,
  idleLabel: function () {
    return "Claim all missing" + (claimableCount ? " (" + claimableCount + ")" : "");
  },
});

// Load only while this tab shows; the batch poll stops when it is hidden.
EpicTabs.on("claims", {
  show: function () {
    load();
    claimBatch.start();
  },
  hide: function () {
    claimBatch.stop();
    clearTimeout(pauseReload);
  },
});
