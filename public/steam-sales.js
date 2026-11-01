// "Selling on Eldorado" card of /steam-accounts.html: ready accounts by
// region, the live region offers, recent sales. API: routes/steamSalesRoutes.js.
// Contract: docs/STEAM-SALES.md.
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var view = null;
  var busy = false;

  var STATUS = {
    active: { label: "On sale", tone: "is-ok" },
    paused: { label: "Paused", tone: "is-warn" },
    sold_out: { label: "Sold out", tone: "" },
    draft: { label: "Creating…", tone: "is-accent" },
    error: { label: "Needs a look", tone: "is-error" },
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    return "$" + (Number(n) || 0).toFixed(2);
  }
  function ago(v) {
    if (!v) return "never";
    var s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    if (!isFinite(s)) return "never";
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function when(v) {
    if (!v) return "";
    var d = new Date(v);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function toast(msg, err) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.t);
    toast.t = setTimeout(function () {
      t.className = "toast";
    }, err ? 6000 : 2600);
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
        .then(function (d) {
          if (!r.ok || d.success === false) throw new Error(d.message || "Request failed (" + r.status + ")");
          return d;
        });
    });
  }

  function load() {
    return api("GET", "/api/steam/sales/overview")
      .then(function (d) {
        view = d;
        render();
      })
      .catch(function (e) {
        $("sellMeta").textContent = "";
        $("sellBody").innerHTML = '<div class="st-empty"><b>Could not load the selling card</b>' + esc(e.message) + "</div>";
      });
  }

  function meta() {
    var c = view.config;
    var bits = [];
    bits.push(c.syncEnabled ? "Sale sync on" : "Sale sync OFF");
    bits.push("checked " + ago(c.lastTickAt) + (c.lastTickOk === false ? " (with errors)" : ""));
    bits.push(view.mailPage.proxyOk ? "mail page OK" : "Mac mail proxy NOT answering");
    if (view.distributor) bits.push("distributor " + view.distributor.mode.toUpperCase());
    $("sellMeta").textContent = bits.join(" · ");
    $("sellMeta").className = "st-card-meta" + (!view.mailPage.proxyOk || c.lastTickOk === false ? " st-warn" : "");
  }

  function readyHtml() {
    if (!view.ready.length) {
      return '<p class="st-muted sell-none">No account is ready to list right now. New accounts from the generator show up here by themselves.</p>';
    }
    var auto = view.distributor && view.distributor.mode === "on";
    return (
      '<ul class="sell-ready">' +
      view.ready
        .map(function (g) {
          var n = g.accounts.length;
          var names = g.accounts.map(function (a) {
            return a.accountName;
          });
          var btn = auto
            ? '<span class="st-badge is-accent">placed automatically</span>'
            : g.liveListingId
              ? '<button type="button" class="btn btn-sm" data-sell="add" data-listing="' + g.liveListingId + '" data-region="' + esc(g.region) + '">Add to Eldorado listing</button>'
              : '<button type="button" class="btn btn-sm btn-primary" data-sell="create" data-region="' + esc(g.region) + '" data-count="' + n + '">List on Eldorado for ' + money(view.config.priceUsd) + "</button>";
          return (
            '<li><span class="cc">' + esc(g.region) + "</span> <b>" + esc(g.regionName) + "</b>" +
            '<span class="st-muted"> · ' + n + " ready</span>" +
            '<span class="sell-names st-small st-muted" title="' + esc(names.join(", ")) + '">' + esc(names.join(", ")) + "</span>" +
            btn + "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function g2gRowsHtml() {
    return (view.g2gOffers || [])
      .map(function (o) {
        var st = !o.enabled ? { label: "Off", tone: "" } : o.listed + o.loading ? { label: "On sale", tone: "is-ok" } : { label: "No stock", tone: "" };
        return (
          '<tr><td><span class="sell-mkt is-g2g">G2G</span></td><td><span class="cc">' + esc(o.region) + "</span> " + esc(o.regionName) + "</td>" +
          '<td class="sell-title"><a href="' + esc(o.url) + '" target="_blank" rel="noopener noreferrer">' + esc(o.title) + "</a>" +
          (o.loading ? '<div class="st-small st-muted">' + o.loading + " loading into G2G's stock</div>" : "") +
          (o.lastError ? '<div class="st-small st-warn">' + esc(o.lastError) + "</div>" : "") + "</td>" +
          '<td class="is-right st-num">' + (o.listed + o.loading) + "</td>" +
          '<td class="is-right st-num">' + o.sold + "</td>" +
          '<td class="is-right st-num">' + money(o.priceUsd) + "</td>" +
          '<td><span class="st-badge ' + st.tone + '">' + esc(st.label) + "</span></td><td></td></tr>"
        );
      })
      .join("");
  }

  function distributorHtml() {
    var d = view.distributor;
    if (!d) return "";
    var modes = [
      ["on", "On", "places every new account on Eldorado or G2G by itself"],
      ["plan", "Plan only", "shows what it would do, places nothing"],
      ["off", "Off", "you list accounts yourself"],
    ];
    var chips = modes
      .map(function (m) {
        return '<button type="button" class="st-chip' + (d.mode === m[0] ? " is-on" : "") + '" data-sell="mode" data-mode="' + m[0] + '" title="' + esc(m[2]) + '">' + esc(m[1]) + "</button>";
      })
      .join("");
    var last = (d.last || []).slice(0, 6)
      .map(function (x) {
        var where = x.market === "g2g" ? "G2G" : x.market === "eldorado" ? "Eldorado" : "nowhere";
        return (
          "<li><b>" + esc(x.accountName) + '</b> <span class="cc">' + esc(x.region) + "</span> → " + where +
          (x.done ? "" : x.error ? ' <span class="st-warn">(failed: ' + esc(x.error) + ")</span>" : ' <span class="st-muted">(plan)</span>') +
          '<div class="st-small st-muted">' + esc(x.why) + " · " + esc(when(x.at)) + "</div></li>"
        );
      })
      .join("");
    var skipped = (d.skipped || [])
      .map(function (s) {
        return (s.market === "g2g" ? "G2G" : "Eldorado") + " paused for " + s.region + " until " + when(s.until);
      })
      .join("; ");
    return (
      '<div class="sell-dist"><h3 class="sell-h">Where new accounts go</h3>' +
      '<div class="sell-dist-row"><div class="st-chips" role="group" aria-label="Distributor">' + chips + "</div>" +
      '<button type="button" class="btn btn-sm" data-sell="distribute">Run now</button></div>' +
      '<p class="st-small st-muted sell-dist-note">Each new account goes to the market with fewer unsold accounts in its country; on a tie, the one that sold more in 14 days; then G2G. Missing offers are created by itself. ' +
      "Last run " + esc(ago(d.lastRunAt)) + (d.lastNote ? ": " + esc(d.lastNote) : "") + ".</p>" +
      (skipped ? '<p class="st-small st-warn">' + esc(skipped) + "</p>" : "") +
      (last ? '<ul class="sell-last">' + last + "</ul>" : "") +
      "</div>"
    );
  }

  function listingsHtml() {
    var live = view.listings;
    if (!live.length && !(view.g2gOffers || []).length) return '<p class="st-muted sell-none">Nothing on sale yet.</p>';
    return (
      '<div class="st-table-wrap"><table class="sell-table"><thead><tr><th>Market</th><th>Region</th><th>Offer</th><th class="is-right">In stock</th><th class="is-right">Sold</th><th class="is-right">Price</th><th>Status</th><th></th></tr></thead><tbody>' +
      live
        .map(function (l) {
          var st = STATUS[l.status] || { label: l.status, tone: "" };
          var actions = [];
          if (l.status === "active") actions.push('<button type="button" class="btn btn-sm btn-ghost" data-sell="pause" data-listing="' + l._id + '">Pause</button>');
          if (l.status === "paused") actions.push('<button type="button" class="btn btn-sm btn-ghost" data-sell="resume" data-listing="' + l._id + '">Resume</button>');
          if (l.status !== "draft") actions.push('<button type="button" class="btn btn-sm btn-ghost" data-sell="delete" data-listing="' + l._id + '">Delete</button>');
          return (
            '<tr><td><span class="sell-mkt">Eldorado</span></td><td><span class="cc">' + esc(l.region) + "</span> " + esc(l.regionName) + "</td>" +
            '<td class="sell-title">' + (l.url ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.title) + "</a>" : esc(l.title)) +
            (l.lastError ? '<div class="st-small st-warn">' + esc(l.lastError) + "</div>" : "") + "</td>" +
            '<td class="is-right st-num">' + l.listed + "</td>" +
            '<td class="is-right st-num">' + l.sold + "</td>" +
            '<td class="is-right st-num">' + money(l.priceUsd) + "</td>" +
            '<td><span class="st-badge ' + st.tone + '">' + esc(st.label) + "</span></td>" +
            '<td class="sell-actions">' + actions.join("") + "</td></tr>"
          );
        })
        .join("") +
      g2gRowsHtml() +
      "</tbody></table></div>"
    );
  }

  function salesHtml() {
    if (!view.sales.length) return '<p class="st-muted sell-none">No sales yet.</p>';
    return (
      '<ul class="sell-sales">' +
      view.sales
        .slice(0, 20)
        .map(function (s) {
          return (
            "<li" + (s.needsAttention ? ' class="is-attn"' : "") + ">" +
            '<span class="st-num">' + esc(when(s.orderCreatedAt)) + "</span>" +
            "<span><span class=\"cc\">" + esc(s.region) + "</span> " + esc(s.accounts.join(", ") || "?") + ' <span class="st-muted st-small">' + (s.market === "g2g" ? "G2G" : "Eldorado") + "</span></span>" +
            '<span class="st-num">' + money(s.priceUsd) + "</span>" +
            '<span class="st-muted st-small">' + esc(s.orderState) + (s.note ? " · " + esc(s.note) : "") + "</span></li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function blockedHtml() {
    if (!view.blocked.length) return "";
    return (
      '<details class="st-help sell-blocked"><summary>' + view.blocked.length + " account(s) in stock can't be listed yet</summary>" +
      "<ul>" +
      view.blocked
        .map(function (b) {
          return "<li><b>" + esc(b.accountName) + "</b>" + (b.region ? ' <span class="cc">' + esc(b.region) + "</span>" : "") + " — " + esc(b.reasons.join("; ")) + "</li>";
        })
        .join("") +
      "</ul></details>"
    );
  }

  function render() {
    meta();
    $("sellBody").innerHTML =
      '<div class="sell-grid">' +
      '<div><h3 class="sell-h">Ready to list</h3>' + readyHtml() + blockedHtml() + "</div>" +
      '<div><h3 class="sell-h">Recent sales</h3>' + salesHtml() + "</div>" +
      "</div>" +
      distributorHtml() +
      '<h3 class="sell-h">Offers</h3>' + listingsHtml() +
      '<details class="st-help sell-how"><summary>What the buyer gets</summary><div class="st-help-body"><div>' +
      "<p>Eldorado hands over the Steam login and password the moment the buyer pays. The email details open our mail page (" +
      esc(view.mailPage.url || "set PUBLIC_BASE_URL") + "), which shows only the emails Steam sends to that account, for " +
      esc(view.config.sessionDays) + " days after the sale. The Outlook inbox itself is never handed over.</p>" +
      "<p>One offer per country on each market; each account sits on one offer only. On G2G the buyer gets the same mail page (14 days); G2G delivers instantly from the stock we load. Sales are recorded every few minutes and sent to Telegram.</p>" +
      "</div></div></details>";
  }

  function run(promise, okText) {
    busy = true;
    return promise
      .then(function () {
        if (okText) toast(okText);
      })
      .catch(function (e) {
        toast(e.message, true);
      })
      .then(function () {
        busy = false;
        return Promise.all([load(), window.SteamAccountsPage ? window.SteamAccountsPage.reload() : null]);
      });
  }

  $("sellBody").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-sell]");
    if (!b || busy) return;
    var act = b.getAttribute("data-sell");
    var id = b.getAttribute("data-listing");
    var region = b.getAttribute("data-region");
    if (act === "create") {
      var n = b.getAttribute("data-count");
      var name = b.closest("li").querySelector("b").textContent;
      var price = prompt(
        "List " + n + " " + name + " account(s) on Eldorado (Steam › Accounts, instant delivery).\nIt goes on sale right away.\n\nPrice per account in USD:",
        String(view.config.priceUsd),
      );
      if (price == null) return;
      b.disabled = true;
      b.textContent = "Listing…";
      return run(api("POST", "/api/steam/sales/listings", { region: region, priceUsd: Number(price) }), name + " is on sale on Eldorado");
    }
    if (act === "add") {
      if (!confirm("Add every ready " + region + " account to its live offer?")) return;
      b.disabled = true;
      return run(api("POST", "/api/steam/sales/listings/" + id + "/add"), "Added to the offer");
    }
    if (act === "mode") {
      var mode = b.getAttribute("data-mode");
      return run(api("PATCH", "/api/steam/sales/distributor", { mode: mode }), "Distributor: " + mode);
    }
    if (act === "distribute") {
      b.disabled = true;
      return run(api("POST", "/api/steam/sales/distribute"), "Distributor ran");
    }
    if (act === "pause") return run(api("POST", "/api/steam/sales/listings/" + id + "/pause"), "Paused");
    if (act === "resume") return run(api("POST", "/api/steam/sales/listings/" + id + "/resume"), "Back on sale");
    if (act === "delete") {
      if (!confirm("Delete this offer from Eldorado? Its unsold accounts go back to stock.")) return;
      return run(api("DELETE", "/api/steam/sales/listings/" + id), "Offer deleted");
    }
  });

  $("sellSync").addEventListener("click", function () {
    if (busy) return;
    var b = $("sellSync");
    b.disabled = true;
    run(Promise.all([api("POST", "/api/steam/sales/sync"), api("POST", "/api/steam/sales/g2g/sweep")]), "Checked").then(function () {
      b.disabled = false;
    });
  });

  load();
  setInterval(function () {
    if (!document.hidden && !busy) load();
  }, 60000);
})();
