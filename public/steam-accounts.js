// Steam accounts page (/steam-accounts.html). Reads /api/steam/accounts, opens one
// account at a time for editing, saves with PATCH. Contract: docs/STEAM-ACCOUNTS.md.
(function () {
  "use strict";

  var STAGES = {
    stock: { label: "In stock", tone: "" },
    listed: { label: "On sale", tone: "is-accent" },
    sold: { label: "Sold", tone: "is-ok" },
    problem: { label: "Needs attention", tone: "is-error" },
    boosting: { label: "Boosting hours", tone: "is-warn" },
  };
  var FILTERS = [
    { key: "all", label: "All" },
    { key: "empty", label: "Empty" },
    { key: "loaded", label: "Loaded" },
    { key: "listed", label: "On sale" },
    { key: "sold", label: "Sold" },
    { key: "boosting", label: "Boosting" },
    { key: "problem", label: "Needs attention" },
  ];
  var CODES = (
    "AD AE AF AG AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL " +
    "CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FR GA GB GD GE GH GM GN GQ GR GT GW GY HK " +
    "HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC " +
    "MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA " +
    "RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS SV SY SZ TD TG TH TJ TL TM TN TR TT TW TZ UA UG US UY " +
    "UZ VC VE VN YE ZA ZM ZW"
  ).split(" ");
  var REVEAL_MS = 60000;
  var REFRESH_MS = 60000;

  var state = {
    accounts: [],
    summary: null,
    loaded: false,
    filter: "all",
    region: "",
    sort: "newest",
    search: "",
    openId: null,
    drafts: {}, // id -> editable copy of the open account
    revealed: {}, // id -> { password, email, timer }
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  var regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch (e) {}
  function countryName(code) {
    if (!code) return "";
    try {
      return (regionNames && regionNames.of(code)) || code;
    } catch (e) {
      return code;
    }
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    return "$" + (Number(n) || 0).toFixed(2);
  }
  function shortDate(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = "toast";
    }, isErr ? 5000 : 2600);
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (r.status === 401) {
            location.href = "/admin-login.html?next=" + encodeURIComponent(location.pathname);
            throw new Error("Signed out");
          }
          if (!r.ok || data.success === false) throw new Error(data.message || "Request failed (" + r.status + ")");
          return data;
        });
    });
  }

  // ---- Load
  function load(quiet) {
    if (isDirty(state.openId)) return Promise.resolve(); // never wipe an unsaved edit
    return api("GET", "/api/steam/accounts")
      .then(function (data) {
        state.accounts = data.accounts || [];
        state.summary = data.summary || null;
        state.loaded = true;
        if (state.openId && !findAccount(state.openId)) state.openId = null;
        render();
      })
      .catch(function (e) {
        if (!quiet) {
          $("list").innerHTML = '<div class="st-empty"><b>Could not load Steam accounts</b>' + esc(e.message) + "</div>";
        }
      });
  }

  function findAccount(id) {
    for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i]._id === id) return state.accounts[i];
    return null;
  }

  // ---- Stats
  function renderStats() {
    var s = state.summary || { total: 0, empty: 0, loaded: 0, listed: 0, sold: 0, stockValueUsd: 0 };
    var tiles = [
      { label: "Accounts", value: s.total, hint: s.problem ? s.problem + " need attention" : "on the server" },
      { label: "Available empty", value: s.availableEmpty || 0, hint: "unreserved stock", tone: s.availableEmpty ? "is-warn" : "" },
      { label: "With games", value: s.loaded, hint: "including licensed farm accounts", tone: s.loaded ? "is-ok" : "" },
      { label: "In preparation", value: s.boosting || 0, hint: (s.preparing || 0) + " game · " + (s.hourBoosting || 0) + " hour boost", tone: "is-accent" },
      { label: "On sale", value: s.listed, hint: "listed on a market", tone: s.listed ? "is-accent" : "" },
      { label: "Sold", value: s.sold, hint: "all time" },
    ];
    $("stats").innerHTML = tiles
      .map(function (t) {
        return (
          '<div class="st-stat ' + (t.tone || "") + '"><span class="st-stat-label">' + esc(t.label) +
          '</span><span class="st-stat-value">' + esc(t.value) + '</span><span class="st-stat-hint">' + esc(t.hint) + "</span></div>"
        );
      })
      .join("");
  }

  // ---- Filters
  function matchesFilter(a, key) {
    if (key === "all") return true;
    if (key === "empty") return !a.loaded && a.stage !== "sold" && a.stage !== "problem";
    if (key === "loaded") return a.loaded && a.stage !== "sold" && a.stage !== "problem";
    return a.stage === key;
  }
  function renderFilters() {
    $("accFilters").innerHTML = FILTERS.map(function (f) {
      var n = state.accounts.filter(function (a) {
        return matchesFilter(a, f.key);
      }).length;
      if (f.key !== "all" && f.key !== state.filter && !n) return "";
      return (
        '<button type="button" class="st-chip' + (state.filter === f.key ? " is-on" : "") + '" data-filter="' + f.key +
        '" aria-pressed="' + (state.filter === f.key) + '">' + esc(f.label) + ' <span class="st-chip-count">' + n + "</span></button>"
      );
    }).join("");

    var regions = {};
    state.accounts.forEach(function (a) {
      var c = a.storeCountry || a.signupCountry;
      if (c) regions[c] = (regions[c] || 0) + 1;
    });
    var codes = Object.keys(regions).sort(function (x, y) {
      return countryName(x).localeCompare(countryName(y));
    });
    if (state.region && !regions[state.region]) state.region = "";
    $("accRegion").innerHTML =
      '<option value="">All regions</option>' +
      codes
        .map(function (c) {
          return '<option value="' + c + '"' + (state.region === c ? " selected" : "") + ">" + esc(countryName(c)) + " (" + regions[c] + ")</option>";
        })
        .join("");
    $("accSort").value = state.sort;
  }

  function visibleAccounts() {
    var q = state.search.trim().toLowerCase();
    var rows = state.accounts.filter(function (a) {
      if (!matchesFilter(a, state.filter)) return false;
      if (state.region && (a.storeCountry || a.signupCountry) !== state.region) return false;
      if (!q) return true;
      var hay = [a.accountName, a.signupCountry, countryName(a.signupCountry), a.storeCountry, countryName(a.storeCountry), a.notes]
        .concat(a.games.map(function (g) {
          return g.name;
        }))
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var time = function (a) {
      return Date.parse(a.signedUpAt || a.importedAt || 0) || 0;
    };
    var sorters = {
      newest: function (a, b) {
        return time(b) - time(a);
      },
      oldest: function (a, b) {
        return time(a) - time(b);
      },
      games: function (a, b) {
        return b.gameCount - a.gameCount || time(b) - time(a);
      },
      value: function (a, b) {
        return b.valueUsd - a.valueUsd || time(b) - time(a);
      },
      region: function (a, b) {
        return countryName(a.storeCountry || a.signupCountry).localeCompare(countryName(b.storeCountry || b.signupCountry)) || time(b) - time(a);
      },
    };
    return rows.sort(sorters[state.sort] || sorters.newest);
  }

  // ---- List
  function stageBadge(stage) {
    var s = STAGES[stage] || STAGES.stock;
    return '<span class="st-badge ' + s.tone + '">' + esc(s.label) + "</span>";
  }
  function regionCell(a) {
    var signup = a.signupCountry ? '<span><span class="cc" title="Signup country">' + esc(a.signupCountry) + "</span> " + esc(countryName(a.signupCountry)) + "</span>" : '<span class="st-muted">Signup country unknown</span>';
    var storeLine = a.storeCountry
      ? '<span class="st-small ' + (a.signupCountry && a.storeCountry !== a.signupCountry ? "st-warn" : "st-ok") + '">Store: ' + esc(countryName(a.storeCountry)) + "</span>"
      : '<span class="st-small st-warn">Store region not checked</span>';
    return '<div class="acc-region">' + signup + storeLine + "</div>";
  }
  function gamesCell(a) {
    if (!a.gameCount) return '<span class="st-muted">No games yet</span>';
    var names = a.games.slice(0, 3).map(function (g) {
      return g.name;
    });
    return (
      "<b>" + a.gameCount + "</b> game" + (a.gameCount === 1 ? "" : "s") +
      '<div class="acc-games-short" title="' + esc(a.games.map(function (g) {
        return g.name;
      }).join(", ")) + '">' + esc(names.join(", ")) + (a.gameCount > 3 ? " …" : "") + "</div>"
    );
  }

  var TWISTY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>';

  function render() {
    renderStats();
    renderFilters();
    var all = state.accounts.length;
    var rows = visibleAccounts();
    $("accCount").textContent = all ? (rows.length === all ? all + " total" : rows.length + " of " + all + " shown") : "";

    if (!state.loaded) return;
    if (!all) {
      $("list").innerHTML =
        '<div class="st-empty"><b>No Steam accounts here yet</b>Accounts made in the Steam generator on your Mac upload here by themselves. Keep the generator running and online.</div>';
      return;
    }
    if (!rows.length) {
      $("list").innerHTML = '<div class="st-empty"><b>No accounts match</b>Try another filter or clear the search.</div>';
      return;
    }
    var html = [
      '<div class="st-table-wrap"><table class="acc-table"><thead><tr><th class="c-toggle"><span hidden>Open</span></th>' +
        "<th>Account</th><th>Region</th><th>Games</th><th class=\"is-right\">Value</th><th>Stage</th></tr></thead><tbody>",
    ];
    rows.forEach(function (a) {
      var open = state.openId === a._id;
      html.push(
        '<tr class="acc-row' + (open ? " is-open" : "") + (a.stage === "sold" ? " is-sold" : "") + '" data-id="' + a._id + '">' +
          '<td class="c-toggle"><button type="button" class="acc-twisty" aria-expanded="' + open + '" aria-label="Open ' + esc(a.accountName) + '">' + TWISTY + "</button></td>" +
          '<td class="c-acct"><div class="acc-name">' + esc(a.accountName) + '</div><div class="acc-sub">Made ' + esc(shortDate(a.signedUpAt || a.importedAt)) + "</div></td>" +
          '<td class="c-region">' + regionCell(a) + "</td>" +
          '<td class="c-games">' + gamesCell(a) + "</td>" +
          '<td class="c-value is-right st-num">' + (a.gameCount ? money(a.valueUsd) : "—") + "</td>" +
          '<td class="c-stage">' + stageBadge(a.stage) + "</td></tr>",
      );
      if (open) html.push('<tr class="acc-detail"><td colspan="6">' + detailHtml(a) + "</td></tr>");
    });
    html.push("</tbody></table></div>");
    $("list").innerHTML = html.join("");
  }

  // ---- Details
  function draftFor(a) {
    if (!state.drafts[a._id]) {
      state.drafts[a._id] = {
        storeCountry: a.storeCountry || "",
        steamId64: a.steamId64 || "",
        notes: a.notes || "",
        stage: a.stage || "stock",
        soldNote: a.soldNote || "",
        games: a.games.map(function (g) {
          return { appId: g.appId, name: g.name, priceUsd: g.priceUsd, addedAt: g.addedAt };
        }),
      };
    }
    return state.drafts[a._id];
  }
  function isDirty(id) {
    var a = id && findAccount(id);
    var d = id && state.drafts[id];
    if (!a || !d) return false;
    return JSON.stringify(payloadOf(d)) !== JSON.stringify(payloadOf(draftFromAccount(a)));
  }
  function draftFromAccount(a) {
    return {
      storeCountry: a.storeCountry || "",
      steamId64: a.steamId64 || "",
      notes: a.notes || "",
      stage: a.stage || "stock",
      soldNote: a.soldNote || "",
      games: a.games,
    };
  }
  function payloadOf(d) {
    return {
      storeCountry: d.storeCountry || null,
      steamId64: (d.steamId64 || "").trim(),
      notes: d.notes || "",
      stage: d.stage,
      soldNote: d.soldNote || "",
      games: d.games.map(function (g) {
        return { appId: g.appId == null || g.appId === "" ? null : Number(g.appId), name: g.name, priceUsd: Number(g.priceUsd) || 0 };
      }),
    };
  }

  function countryOptions(selected) {
    var opts = CODES.map(function (c) {
      return { c: c, n: countryName(c) };
    }).sort(function (x, y) {
      return x.n.localeCompare(y.n);
    });
    return (
      '<option value="">Not checked yet</option>' +
      opts
        .map(function (o) {
          return '<option value="' + o.c + '"' + (selected === o.c ? " selected" : "") + ">" + esc(o.n) + " (" + o.c + ")</option>";
        })
        .join("")
    );
  }

  function detailHtml(a) {
    var d = draftFor(a);
    var r = state.revealed[a._id];
    var dirty = isDirty(a._id);
    var games = d.games.length
      ? '<ul class="game-list">' +
        d.games
          .map(function (g, i) {
            var name = g.appId != null && g.appId !== ""
              ? '<a href="https://store.steampowered.com/app/' + encodeURIComponent(g.appId) + '/" target="_blank" rel="noopener noreferrer">' + esc(g.name) + "</a>"
              : esc(g.name);
            return (
              '<li><span class="g-name">' + name + (g.appId != null && g.appId !== "" ? ' <span class="st-muted st-small">#' + esc(g.appId) + "</span>" : "") +
              '</span><span class="g-price">' + money(g.priceUsd) + '</span><button type="button" class="btn btn-ghost btn-sm" data-act="game-remove" data-index="' + i +
              '" aria-label="Remove ' + esc(g.name) + '">Remove</button></li>'
            );
          })
          .join("") +
        "</ul>"
      : '<p class="game-empty">No games on this account yet. Add each game once it is on the account.</p>';

    var password = r ? '<span class="st-mono">' + esc(r.password) + "</span>" : '<span class="st-muted">Hidden</span>';
    var email = r ? '<span class="st-mono">' + esc(r.email) + "</span>" : '<span class="st-muted">Hidden</span>';
    var profile = d.steamId64 && /^7656119\d{10}$/.test(d.steamId64)
      ? ' <a class="st-small" href="https://steamcommunity.com/profiles/' + esc(d.steamId64) + '" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">Open profile</a>'
      : "";

    return (
      '<div class="acc-detail-grid" data-detail="' + a._id + '">' +
      "<div>" +
      '<div class="acc-section"><h4>Games on this account</h4>' + games +
      '<div class="game-add"><input type="text" data-new="name" placeholder="Game name" aria-label="Game name" maxlength="160" />' +
      '<input type="number" data-new="appId" placeholder="App ID" aria-label="Steam app ID" min="0" step="1" />' +
      '<input type="number" data-new="priceUsd" placeholder="Price $" aria-label="Store price in USD" min="0" step="0.01" />' +
      '<button type="button" class="btn btn-sm" data-act="game-add">Add game</button></div></div>' +
      '<div class="acc-section"><h4>Notes</h4><textarea data-field="notes" maxlength="2000" placeholder="Anything to remember about this account">' + esc(d.notes) + "</textarea></div>" +
      "</div>" +
      "<div>" +
      '<div class="acc-section"><h4>Login</h4>' +
      '<div class="cred"><span>Account name</span><span class="st-mono">' + esc(a.accountName) + '</span><span class="cred-actions"><button type="button" class="btn btn-sm" data-act="copy-name">Copy</button></span></div>' +
      '<div class="cred"><span>Password</span>' + password + '<span class="cred-actions">' +
      (r ? "" : '<button type="button" class="btn btn-sm" data-act="reveal">Show</button>') +
      '<button type="button" class="btn btn-sm" data-act="copy-password">Copy</button></span></div>' +
      '<div class="cred"><span>Email</span>' + email + '<span class="cred-actions"><button type="button" class="btn btn-sm" data-act="copy-email">Copy</button></span></div>' +
      (r ? '<p class="st-muted st-small" style="margin:4px 0 0">Hidden again in a minute, or when you leave the page.</p>' : "") +
      "</div>" +
      '<div class="acc-section"><h4>Region</h4><dl class="facts">' +
      "<dt>Signup form</dt><dd>" + (a.signupCountry ? esc(countryName(a.signupCountry)) + " (" + esc(a.signupCountry) + ")" : "Unknown") + "</dd>" +
      "<dt>Proxy at signup</dt><dd>" + (a.proxyCountry ? esc(countryName(a.proxyCountry)) + (a.proxyCity ? " · " + esc(a.proxyCity) : "") : "Not recorded") + "</dd>" +
      "</dl>" +
      '<div class="form-2"><label class="st-field">Store region (checked in Steam)<select data-field="storeCountry">' + countryOptions(d.storeCountry) + "</select></label>" +
      '<label class="st-field">Steam ID' + profile + '<input type="text" data-field="steamId64" value="' + esc(d.steamId64) + '" placeholder="7656119…" inputmode="numeric" maxlength="17" autocomplete="off" /></label></div>' +
      "</div>" +
      '<div class="acc-section"><h4>Stage</h4><div class="form-2"><label class="st-field">Stage<select data-field="stage">' +
      Object.keys(STAGES)
        .filter(function (k) {
          return k !== "boosting" || d.stage === "boosting"; // set on the Hour boost tab only
        })
        .map(function (k) {
          return '<option value="' + k + '"' + (d.stage === k ? " selected" : "") + ">" + esc(STAGES[k].label) + "</option>";
        })
        .join("") +
      "</select></label>" +
      '<label class="st-field"' + (d.stage === "sold" ? "" : " hidden") + ">Sold where / order<input type=\"text\" data-field=\"soldNote\" value=\"" + esc(d.soldNote) + '" maxlength="300" placeholder="e.g. Eldorado order 123" /></label></div>' +
      (a.soldAt ? '<p class="st-muted st-small" style="margin:6px 0 0">Marked sold ' + esc(shortDate(a.soldAt)) + "</p>" : "") +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="acc-actions"><button type="button" class="btn btn-primary" data-act="save"' + (dirty ? "" : " disabled") + ">Save changes</button>" +
      '<button type="button" class="btn" data-act="discard"' + (dirty ? "" : " disabled") + ">Discard</button>" +
      (dirty ? '<span class="st-dirty">Unsaved changes</span>' : "") +
      '<span class="spacer"></span><span class="st-muted st-small">Added ' + esc(shortDate(a.importedAt)) + "</span></div>"
    );
  }

  // Re-render only the action bar, so typing in a field never loses focus.
  function refreshActions(id) {
    var wrap = document.querySelector('[data-detail="' + id + '"]');
    if (!wrap) return;
    var bar = wrap.parentNode.querySelector(".acc-actions");
    if (!bar) return;
    var dirty = isDirty(id);
    bar.querySelector('[data-act="save"]').disabled = !dirty;
    bar.querySelector('[data-act="discard"]').disabled = !dirty;
    var flag = bar.querySelector(".st-dirty");
    if (dirty && !flag) {
      flag = document.createElement("span");
      flag.className = "st-dirty";
      flag.textContent = "Unsaved changes";
      bar.insertBefore(flag, bar.querySelector(".spacer"));
    } else if (!dirty && flag) flag.remove();
  }

  function toggle(id) {
    if (state.openId === id) {
      if (isDirty(id) && !confirm("Close without saving your changes?")) return;
      delete state.drafts[id];
      state.openId = null;
    } else {
      if (state.openId && isDirty(state.openId)) {
        if (!confirm("You have unsaved changes on another account. Discard them?")) return;
      }
      if (state.openId) delete state.drafts[state.openId];
      state.openId = id;
    }
    render();
  }

  function hideSecrets(id) {
    var ids = id ? [id] : Object.keys(state.revealed);
    var changed = false;
    ids.forEach(function (k) {
      if (state.revealed[k]) {
        clearTimeout(state.revealed[k].timer);
        delete state.revealed[k];
        changed = true;
      }
    });
    if (changed) render();
  }

  function credentials(id) {
    if (state.revealed[id]) return Promise.resolve(state.revealed[id]);
    return api("GET", "/api/steam/accounts/" + encodeURIComponent(id) + "/credentials");
  }

  function copyText(text, what) {
    var done = function () {
      toast(what + " copied");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text) ? done() : toast("Could not copy", true);
      });
    }
    fallbackCopy(text) ? done() : toast("Could not copy", true);
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {}
    ta.remove();
    return ok;
  }

  function save(id, btn) {
    var d = state.drafts[id];
    if (!d) return;
    var body = payloadOf(d);
    var a = findAccount(id);
    if (a && a.stage === "sold" && body.stage !== "sold" && !confirm("This account is marked sold. Move it back to " + STAGES[body.stage].label + "?")) return;
    if (a && a.stage !== "sold" && body.stage === "sold" && !confirm("Mark " + a.accountName + " as sold?")) return;
    btn.disabled = true;
    btn.textContent = "Saving…";
    api("PATCH", "/api/steam/accounts/" + encodeURIComponent(id), body)
      .then(function (data) {
        var i = state.accounts.findIndex(function (x) {
          return x._id === id;
        });
        if (i !== -1) state.accounts[i] = data.account;
        delete state.drafts[id];
        toast("Saved");
        return load(true).then(render);
      })
      .catch(function (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = "Save changes";
      });
  }

  // ---- Events
  $("list").addEventListener("click", function (ev) {
    var actBtn = ev.target.closest("[data-act]");
    if (actBtn) {
      var wrap = actBtn.closest(".acc-detail");
      var id = wrap ? wrap.querySelector("[data-detail]").getAttribute("data-detail") : null;
      var act = actBtn.getAttribute("data-act");
      var a = id && findAccount(id);
      if (!a) return;
      var d = draftFor(a);
      if (act === "copy-name") return copyText(a.accountName, "Account name");
      if (act === "reveal" || act === "copy-password" || act === "copy-email") {
        actBtn.disabled = true;
        credentials(id)
          .then(function (c) {
            if (act === "reveal") {
              var timer = setTimeout(function () {
                hideSecrets(id);
              }, REVEAL_MS);
              state.revealed[id] = { password: c.password, email: c.email, timer: timer };
              render();
            } else if (act === "copy-password") copyText(c.password, "Password");
            else copyText(c.email, "Email");
          })
          .catch(function (e) {
            toast(e.message, true);
          })
          .then(function () {
            actBtn.disabled = false;
          });
        return;
      }
      if (act === "game-add") {
        var box = actBtn.closest(".game-add");
        var nameEl = box.querySelector('[data-new="name"]');
        var appEl = box.querySelector('[data-new="appId"]');
        var priceEl = box.querySelector('[data-new="priceUsd"]');
        var name = nameEl.value.trim().replace(/\s+/g, " ");
        if (!name) {
          nameEl.focus();
          return toast("Type the game's name first", true);
        }
        var appId = appEl.value === "" ? null : Number(appEl.value);
        if (appId !== null && (!Number.isInteger(appId) || appId < 0)) return toast("The app ID is the number in the game's Steam store link", true);
        var price = priceEl.value === "" ? 0 : Number(priceEl.value);
        if (!isFinite(price) || price < 0) return toast("The price must be 0 or more", true);
        var dup = d.games.some(function (g) {
          return appId !== null ? Number(g.appId) === appId : String(g.name).toLowerCase() === name.toLowerCase();
        });
        if (dup) return toast(name + " is already in the list", true);
        d.games.push({ appId: appId, name: name, priceUsd: Math.round(price * 100) / 100, addedAt: new Date().toISOString() });
        render();
        var again = document.querySelector('[data-detail="' + id + '"] [data-new="name"]');
        if (again) again.focus();
        return;
      }
      if (act === "game-remove") {
        d.games.splice(Number(actBtn.getAttribute("data-index")), 1);
        return render();
      }
      if (act === "discard") {
        delete state.drafts[id];
        return render();
      }
      if (act === "save") return save(id, actBtn);
      return;
    }
    var row = ev.target.closest(".acc-row");
    if (row) toggle(row.getAttribute("data-id"));
  });

  $("list").addEventListener("input", function (ev) {
    var el = ev.target;
    var field = el.getAttribute("data-field");
    if (!field) return;
    var wrap = el.closest("[data-detail]");
    var id = wrap && wrap.getAttribute("data-detail");
    var a = id && findAccount(id);
    if (!a) return;
    var d = draftFor(a);
    d[field] = el.value;
    if (field === "stage") {
      var sold = wrap.querySelector('[data-field="soldNote"]');
      if (sold) sold.closest("label").hidden = el.value !== "sold";
    }
    refreshActions(id);
  });
  $("list").addEventListener("change", function (ev) {
    if (ev.target.matches("select[data-field]")) ev.target.dispatchEvent(new Event("input", { bubbles: true }));
  });
  $("list").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.matches("[data-new]")) {
      ev.preventDefault();
      var btn = ev.target.closest(".game-add").querySelector('[data-act="game-add"]');
      if (btn) btn.click();
    }
  });

  $("accFilters").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-filter]");
    if (!b) return;
    state.filter = b.getAttribute("data-filter");
    store("steam.accounts.filter", state.filter);
    render();
  });
  $("accSearch").addEventListener("input", function (ev) {
    state.search = ev.target.value;
    render();
  });
  $("accRegion").addEventListener("change", function (ev) {
    state.region = ev.target.value;
    render();
  });
  $("accSort").addEventListener("change", function (ev) {
    state.sort = ev.target.value;
    store("steam.accounts.sort", state.sort);
    render();
  });
  $("btnRefresh").addEventListener("click", function () {
    if (isDirty(state.openId)) return toast("Save or discard your changes first", true);
    load().then(function () {
      toast("Up to date");
    });
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) hideSecrets();
    else load(true);
  });
  window.addEventListener("beforeunload", function (ev) {
    if (isDirty(state.openId)) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  state.filter = FILTERS.some(function (f) {
    return f.key === store("steam.accounts.filter");
  })
    ? store("steam.accounts.filter")
    : "all";
  state.sort = store("steam.accounts.sort") || "newest";
  // The selling card (steam-sales.js) reloads the list after it lists or
  // removes accounts, since that changes their stage.
  window.SteamAccountsPage = { reload: function () { return load(true); } };
  load();
  setInterval(function () {
    if (!document.hidden) load(true);
  }, REFRESH_MS);
})();
