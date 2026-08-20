// Banned accounts page.
//
// Every panel here is loaded independently so one slow aggregation can't hold
// the whole page hostage — the KPIs and the timeline are what the page is for,
// and they come from the cheapest query.
(function () {
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
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function num(n) {
    return (n == null ? 0 : n).toLocaleString();
  }

  function fmtDate(s) {
    if (!s) return "—";
    try {
      var d = new Date(s);
      return (
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      );
    } catch (e) {
      return String(s);
    }
  }

  function fmtDay(s) {
    if (!s) return "—";
    try {
      return new Date(s).toLocaleDateString();
    } catch (e) {
      return String(s);
    }
  }

  function days(n) {
    if (n == null) return "—";
    if (n < 1) return (n * 24).toFixed(0) + "h";
    return n.toFixed(n < 10 ? 1 : 0) + "d";
  }

  async function api(url, opts) {
    var r = await fetch(
      url,
      Object.assign({ credentials: "same-origin" }, opts || {}),
    );
    var j = await r.json().catch(function () {
      return {};
    });
    if (!r.ok || j.success === false)
      throw new Error(j.message || "HTTP " + r.status);
    return j;
  }

  // ----------------------------------------------------------------
  // Summary + timeline
  // ----------------------------------------------------------------
  async function loadSummary() {
    try {
      var d = await api("/banned/summary?days=" + ($("rangeSel").value || 90));
      renderKpis(d);
      renderChart(d.series);
    } catch (e) {
      $("kpis").innerHTML =
        '<div class="kpi"><div class="k">Error</div><div class="v">—</div>' +
        '<div class="f">' +
        esc(e.message) +
        "</div></div>";
    }
  }

  function kpi(k, v, f, cls) {
    return (
      '<div class="kpi ' +
      (cls || "") +
      '"><div class="k">' +
      esc(k) +
      '</div><div class="v">' +
      v +
      '</div><div class="f">' +
      (f || "") +
      "</div></div>"
    );
  }

  function renderKpis(d) {
    var t = d.totals || {};
    var rate = (d.rate || 0).toFixed(1);
    var age = d.ageAtBan || {};
    var s = d.sources || {};
    var html = "";
    // The bot/pool split is spelled out rather than summed away: it is the
    // difference between losing accounts that were farming and losing accounts
    // that never got deployed, and for a long time this page showed only the
    // first — a 67-account pool wave read as zero here.
    html += kpi(
      "Banned",
      num(t.banned),
      "of " +
        num(t.total) +
        " accounts · " +
        num(s.bot) +
        " bot / " +
        num(s.pool) +
        " pool",
      "bad",
    );
    html += kpi(
      "Ban rate",
      rate + "%",
      "share of the whole fleet",
      Number(rate) >= 10 ? "bad" : Number(rate) >= 3 ? "warn" : "good",
    );
    // Healthy/token-invalid are counted on the deployed side only, so they are
    // shown against the deployed population — dividing a bot-only count by the
    // fleet-wide total would quietly understate both.
    html += kpi(
      "Healthy",
      num(t.healthy),
      s.botPopulation
        ? ((t.healthy / s.botPopulation) * 100).toFixed(1) + "% of deployed"
        : "",
      "good",
    );
    html += kpi(
      "Token invalid",
      num(t.reauthable),
      "re-authable, not banned",
      "warn",
    );
    html += kpi(
      "Banned last 7d",
      num(d.recent && d.recent.d7),
      num(d.recent && d.recent.d1) + " in the last 24h",
      d.recent && d.recent.d7 > 0 ? "warn" : "good",
    );
    html += kpi("Banned last 30d", num(d.recent && d.recent.d30), "");
    html += kpi(
      "Median age at ban",
      age.median == null ? "—" : days(age.median),
      age.median == null
        ? ""
        : "p10 " + days(age.p10) + " · p90 " + days(age.p90),
      age.median != null && age.median < 14 ? "bad" : "",
    );
    html += kpi(
      "Biggest single day",
      d.biggestDay ? num(d.biggestDay.n) : "—",
      d.biggestDay ? fmtDay(d.biggestDay.day) : "no bans in range",
      d.biggestDay && d.biggestDay.n > 50 ? "bad" : "",
    );
    if (d.bannedNoDate) {
      html += kpi(
        "Undated bans",
        num(d.bannedNoDate),
        "banned but no date — missing from the chart",
        "warn",
      );
    }
    $("kpis").innerHTML = html;
  }

  // Inline SVG bar chart. No library: the page has to work with a strict
  // no-external-requests posture and one chart doesn't justify a dependency.
  function renderChart(series) {
    var box = $("chart");
    if (!series || !series.length) {
      box.innerHTML = '<div class="hint">No bans recorded in this range.</div>';
      return;
    }
    // Fill the gaps — a chart that silently skips quiet days makes a wave look
    // like a trend.
    var first = new Date(series[0].day + "T00:00:00Z");
    var last = new Date(series[series.length - 1].day + "T00:00:00Z");
    var byDay = {};
    series.forEach(function (r) {
      byDay[r.day] = r;
    });
    var all = [];
    for (var t = first.getTime(); t <= last.getTime(); t += 86400000) {
      var key = new Date(t).toISOString().slice(0, 10);
      var r = byDay[key];
      all.push({
        day: key,
        n: r ? r.n : 0,
        bot: r ? r.bot || 0 : 0,
        pool: r ? r.pool || 0 : 0,
      });
    }

    var total = all.reduce(function (s, r) {
      return s + r.n;
    }, 0);
    var avg = total / all.length;
    var max = all.reduce(function (m, r) {
      return Math.max(m, r.n);
    }, 0);

    var barW = Math.max(4, Math.min(22, Math.floor(940 / all.length)));
    var gap = barW > 7 ? 2 : 1;
    var W = all.length * (barW + gap) + 46;
    var H = 210;
    var plotH = H - 34;

    var svg =
      '<svg width="' +
      W +
      '" height="' +
      H +
      '" viewBox="0 0 ' +
      W +
      " " +
      H +
      '">';
    // y gridlines
    [0, 0.5, 1].forEach(function (f) {
      var y = 8 + plotH * (1 - f);
      svg +=
        '<line class="axis" x1="40" y1="' +
        y +
        '" x2="' +
        (W - 4) +
        '" y2="' +
        y +
        '" />';
      svg +=
        '<text class="axis-text" x="34" y="' +
        (y + 3) +
        '" text-anchor="end">' +
        Math.round(max * f) +
        "</text>";
    });

    // Each bar is stacked bot-under-pool. A day's total is the number that
    // matters, but which half it landed on changes what it means — accounts
    // dying in the pool never farmed anything, so a pool-heavy wave is a supply
    // problem while a bot-heavy one is a live-fleet problem.
    all.forEach(function (r, i) {
      var h = max ? (r.n / max) * plotH : 0;
      var x = 40 + i * (barW + gap);
      var y = 8 + plotH - h;
      var isWave = r.n > avg * 3 && r.n > 5;
      var tip =
        esc(r.day) +
        " — " +
        r.n +
        " banned (" +
        r.bot +
        " bot, " +
        r.pool +
        " pool)";
      var botH = r.n ? (r.bot / r.n) * h : 0;
      var poolH = Math.max(0, h - botH);
      if (poolH > 0) {
        svg +=
          '<rect class="bar pool" x="' +
          x +
          '" y="' +
          y +
          '" width="' +
          barW +
          '" height="' +
          Math.max(1, poolH) +
          '" rx="1"><title>' +
          tip +
          "</title></rect>";
      }
      if (r.bot > 0) {
        svg +=
          '<rect class="bar' +
          (isWave ? " wave" : "") +
          '" x="' +
          x +
          '" y="' +
          (y + poolH) +
          '" width="' +
          barW +
          '" height="' +
          Math.max(1, botH) +
          '" rx="1"><title>' +
          tip +
          "</title></rect>";
      }
    });

    // x labels: first, middle, last — enough to orient without crowding
    [0, Math.floor(all.length / 2), all.length - 1].forEach(function (i) {
      if (i < 0 || i >= all.length) return;
      var x = 40 + i * (barW + gap) + barW / 2;
      svg +=
        '<text class="axis-text" x="' +
        x +
        '" y="' +
        (H - 8) +
        '" text-anchor="middle">' +
        esc(all[i].day.slice(5)) +
        "</text>";
    });
    svg += "</svg>";
    box.innerHTML = svg;
  }

  // ----------------------------------------------------------------
  // Exposure
  // ----------------------------------------------------------------
  async function loadExposure() {
    try {
      var d = await api("/banned/exposure");
      renderExposure(d);
      renderSold(d);
      renderLost(d);
    } catch (e) {
      $("exposureBody").innerHTML =
        '<div class="hint">Error: ' + esc(e.message) + "</div>";
    }
  }

  function renderExposure(d) {
    var rows = d.liveListings || [];
    var card = $("exposureCard");
    if (!rows.length) {
      card.classList.remove("danger");
      $("exposureBody").innerHTML =
        '<div class="hint"><b>Clear</b> — no banned account is attached to an ' +
        "active listing.</div>";
      return;
    }
    card.classList.add("danger");
    var html =
      '<div style="margin-bottom:10px"><span class="chip red">' +
      rows.length +
      " listing(s) affected</span> " +
      '<span class="chip grey">$' +
      (d.liveValue || 0).toFixed(2) +
      " listed value</span></div>";
    html +=
      '<div class="tablewrap"><table><thead><tr><th>Account</th>' +
      "<th>Marketplace</th><th>Listing</th><th>Price</th><th>Banned</th>" +
      "</tr></thead><tbody>";
    rows.forEach(function (r) {
      html +=
        "<tr><td class='mono'>" +
        esc(r.login) +
        '</td><td><span class="chip grey">' +
        esc(r.marketplace) +
        "</span></td><td>" +
        (r.url
          ? '<a href="' +
            esc(r.url) +
            '" target="_blank" rel="noopener">' +
            esc(r.title || r.url) +
            "</a>"
          : esc(r.title || "—")) +
        "</td><td>" +
        (r.price ? esc(r.currency) + " " + r.price : "—") +
        "</td><td>" +
        fmtDate(r.suspendedAt) +
        "</td></tr>";
    });
    html += "</tbody></table></div>";
    $("exposureBody").innerHTML = html;
  }

  // Delivered ≠ reserved. `soldToUsername` carries a platform tag when an
  // account is merely held against a listing, so this panel shows the two
  // populations separately — the top one is customers, the bottom is stock.
  function renderSold(d) {
    var rows = d.delivered || [];
    var html = "";
    if (!rows.length) {
      html =
        '<div class="hint"><b>None</b> — no banned account was ever delivered ' +
        "to a buyer.</div>";
    } else {
      if (d.deliveredFast) {
        html +=
          '<div style="margin-bottom:10px"><span class="chip red">' +
          d.deliveredFast +
          " died within 14 days of delivery</span></div>";
      }
      html +=
        '<div class="tablewrap" style="max-height:300px"><table><thead><tr>' +
        "<th>Account</th><th>Buyer</th><th>Delivered</th><th>Banned</th><th>Gap</th>" +
        "</tr></thead><tbody>";
      rows.slice(0, 200).forEach(function (r) {
        var fast = r.daysAfterSale != null && r.daysAfterSale <= 14;
        html +=
          "<tr><td class='mono'>" +
          esc(r.login) +
          "</td><td>" +
          esc(r.soldToUsername || "—") +
          "</td><td>" +
          fmtDay(r.soldAt) +
          "</td><td>" +
          fmtDay(r.suspendedAt) +
          '</td><td><span class="chip ' +
          (fast ? "red" : "grey") +
          '">' +
          days(r.daysAfterSale) +
          "</span></td></tr>";
      });
      html += "</tbody></table></div>";
    }

    if (d.reservedTotal) {
      html +=
        '<div class="hint" style="margin-top:14px;padding-top:12px;' +
        'border-top:1px solid var(--line)"><b>' +
        num(d.reservedTotal) +
        " more</b> were held against a marketplace listing when they died " +
        "(the <span class='mono'>digiseller</span>/<span class='mono'>ggsel</span>" +
        "-style tags in <span class='mono'>soldToUsername</span> are platform " +
        "reservations, not buyers). That's lost stock, not a wronged customer.</div>";
    }
    $("soldBody").innerHTML = html;
  }

  function renderLost(d) {
    var rows = d.lostDropsByGame || [];
    if (!rows.length) {
      $("lostBody").innerHTML =
        '<div class="hint">No farmed drops on banned accounts.</div>';
      return;
    }
    var html =
      '<div style="margin-bottom:12px"><span class="chip red">' +
      num(d.lostDropsTotal) +
      " drops lost</span></div>";
    var max = rows[0].n || 1;
    rows.forEach(function (r) {
      html += bar(r.game, (r.n / max) * 100, num(r.n));
    });
    $("lostBody").innerHTML = html;
  }

  function bar(label, pctWidth, right, subtitle) {
    return (
      '<div class="ratebar"><div class="track">' +
      '<div class="fill" style="width:' +
      Math.max(1, Math.min(100, pctWidth)) +
      '%"></div>' +
      '<div class="lbl"><span>' +
      esc(label) +
      "</span><span>" +
      esc(subtitle || "") +
      '</span></div></div><div class="num">' +
      esc(right) +
      "</div></div>"
    );
  }

  // ----------------------------------------------------------------
  // Analytics
  // ----------------------------------------------------------------
  async function loadAnalytics() {
    try {
      var d = await api("/banned/analytics");
      renderRates("hostBody", d.byHost, "No host data.");
      renderCommitment(d.commitment);
      renderAge(d.ageHistogram);
      renderCohorts(d.cohorts);
    } catch (e) {
      $("hostBody").innerHTML =
        '<div class="hint">Error: ' + esc(e.message) + "</div>";
    }
  }

  // What each banned account was committed to when it died. Platform tags and
  // real buyers are drawn apart on purpose: only the second group is customers.
  function renderCommitment(c) {
    if (!c) {
      $("commitBody").innerHTML = '<div class="hint">No data.</div>';
      return;
    }
    var listing = c.listing || [];
    var buyer = c.buyer || [];
    var bulk = c.bulk || [];
    var reseller = c.reseller || [];
    var totalListing = listing.reduce(function (s, r) {
      return s + r.n;
    }, 0);
    var max = Math.max(
      1,
      totalListing,
      buyer.reduce(function (s, r) {
        return s + r.n;
      }, 0),
      bulk.reduce(function (s, r) {
        return s + r.n;
      }, 0),
      reseller.reduce(function (s, r) {
        return s + r.n;
      }, 0),
      c.none || 0,
    );

    var html = "";
    listing.forEach(function (r) {
      html += bar(r.label, (r.n / max) * 100, num(r.n), "listing hold");
    });
    var buyerTotal = buyer.reduce(function (s, r) {
      return s + r.n;
    }, 0);
    if (buyerTotal) {
      html += bar(
        "Delivered to a buyer",
        (buyerTotal / max) * 100,
        num(buyerTotal),
        buyer
          .slice(0, 3)
          .map(function (b) {
            return b.label;
          })
          .join(", "),
      );
    }
    var bulkTotal = bulk.reduce(function (s, r) {
      return s + r.n;
    }, 0);
    if (bulkTotal) {
      html += bar("Bulk orders", (bulkTotal / max) * 100, num(bulkTotal), "");
    }
    var resellerTotal = reseller.reduce(function (s, r) {
      return s + r.n;
    }, 0);
    if (resellerTotal) {
      html += bar(
        "Reseller handoffs",
        (resellerTotal / max) * 100,
        num(resellerTotal),
        reseller
          .slice(0, 3)
          .map(function (r) {
            return r.label;
          })
          .join(", "),
      );
    }
    if (c.none) {
      html += bar(
        "Uncommitted",
        (c.none / max) * 100,
        num(c.none),
        "free stock",
      );
    }
    html +=
      '<div class="hint" style="margin-top:12px">Platform names are ' +
      "<b>reservation tags</b> — an account held against a live listing, not " +
      "one sold to a person.</div>";
    $("commitBody").innerHTML = html;
  }

  function renderRates(target, rows, emptyMsg) {
    if (!rows || !rows.length) {
      $(target).innerHTML = '<div class="hint">' + emptyMsg + "</div>";
      return;
    }
    var html = "";
    rows.forEach(function (r) {
      html += bar(
        r.key,
        r.rate,
        r.rate.toFixed(1) + "%",
        num(r.banned) + " / " + num(r.total),
      );
    });
    $(target).innerHTML = html;
  }

  function renderAge(hist) {
    if (!hist || !hist.length) {
      $("ageBody").innerHTML = '<div class="hint">No aged bans.</div>';
      return;
    }
    var max =
      hist.reduce(function (m, r) {
        return Math.max(m, r.n);
      }, 0) || 1;
    var html = "";
    hist.forEach(function (r) {
      html += bar(r.label, (r.n / max) * 100, num(r.n));
    });
    $("ageBody").innerHTML = html;
  }

  function renderCohorts(rows) {
    rows = (rows || []).filter(function (r) {
      return r.total >= 3;
    });
    if (!rows.length) {
      $("cohortBody").innerHTML =
        '<div class="hint">No intake in the last 120 days.</div>';
      return;
    }
    var worst = rows
      .slice()
      .sort(function (a, b) {
        return b.rate - a.rate;
      })
      .slice(0, 14);
    var html = "";
    worst.forEach(function (r) {
      html += bar(
        r.day,
        r.rate,
        r.rate.toFixed(0) + "%",
        num(r.banned) + " / " + num(r.total),
      );
    });
    $("cohortBody").innerHTML = html;
  }

  window.loadSummary = loadSummary;
  window.__banned = {
    api: api,
    esc: esc,
    num: num,
    fmtDate: fmtDate,
    fmtDay: fmtDay,
    days: days,
    toast: toast,
    $: $,
    loadExposure: loadExposure,
    loadAnalytics: loadAnalytics,
  };
})();

// ------------------------------------------------------------------
// The account table
// ------------------------------------------------------------------
(function () {
  var H = window.__banned;
  var $ = H.$;
  var esc = H.esc;
  var num = H.num;

  var state = {
    page: 1,
    total: 0,
    limit: 100,
    sort: "suspendedAt",
    dir: "desc",
    rows: [],
  };

  // label, key (null = not sortable), renderer
  var COLUMNS = [
    [
      "Login",
      "login",
      function (a) {
        return (
          '<span class="login" data-id="' +
          a.id +
          '">' +
          esc(a.login || "(none)") +
          "</span>" +
          // Pool rows are marked because almost every other column reads
          // differently for them: an empty host or a zero drop count means
          // "never deployed", not "deployed and produced nothing".
          (a.source === "pool"
            ? ' <span class="chip grey" title="Account pool row — never ' +
              'deployed into a bot config">pool</span>'
            : "") +
          (a.twitchId
            ? '<div class="hint mono">' + esc(a.twitchId) + "</div>"
            : "")
        );
      },
    ],
    [
      "Status",
      null,
      function (a) {
        var cls =
          a.status === "suspended"
            ? "red"
            : a.status === "token_invalid"
              ? "amber"
              : "grey";
        var label = a.status === "suspended" ? "banned" : a.status;
        return '<span class="chip ' + cls + '">' + esc(label) + "</span>";
      },
    ],
    [
      "Banned",
      "suspendedAt",
      function (a) {
        return a.suspendedAt
          ? H.fmtDate(a.suspendedAt)
          : '<span class="hint">—</span>';
      },
    ],
    [
      "Age at ban",
      null,
      function (a) {
        var d = a.ageDays;
        if (d == null) return '<span class="hint">—</span>';
        return (
          '<span class="chip ' +
          (d < 7 ? "red" : d < 30 ? "amber" : "grey") +
          '">' +
          H.days(d) +
          "</span>"
        );
      },
    ],
    [
      "Added",
      "createdAt",
      function (a) {
        return H.fmtDay(a.createdAt);
      },
    ],
    [
      "Host",
      "host",
      function (a) {
        if (!a.host) return '<span class="hint">not deployed</span>';
        return '<span class="chip grey">' + esc(a.host) + "</span>";
      },
    ],
    [
      "Config",
      "configFile",
      function (a) {
        if (a.source === "pool") {
          return (
            '<span class="hint">' +
            esc(a.poolStatus === "claimed" ? "claimed in pool" : "in pool") +
            "</span>"
          );
        }
        return (
          '<span class="mono">' +
          esc(a.configFile || "—") +
          "</span>" +
          (a.container
            ? '<div class="hint mono">' + esc(a.container) + "</div>"
            : "")
        );
      },
    ],
    [
      "Drops",
      "dropCount",
      function (a) {
        var n = a.dropsLogged || a.dropCount || 0;
        return (
          num(n) +
          (a.games && a.games.length
            ? '<div class="hint">' +
              esc(a.games.slice(0, 3).join(", ")) +
              (a.games.length > 3 ? " +" + (a.games.length - 3) : "") +
              "</div>"
            : "")
        );
      },
    ],
    [
      "Committed to",
      "soldAt",
      function (a) {
        if (!a.soldAt) return '<span class="hint">—</span>';
        // A platform tag is a listing hold; a name is a real delivery. Only
        // the latter deserves the alarming colour.
        var isBuyer = a.commitment === "buyer" || a.commitment === "bulk";
        var fast = a.soldToBanDays != null && a.soldToBanDays <= 14;
        return (
          '<span class="chip ' +
          (isBuyer ? "red" : "grey") +
          '">' +
          esc(a.commitmentLabel || a.soldToUsername || "—") +
          "</span>" +
          '<div class="hint">' +
          (isBuyer ? "delivered " : "reserved ") +
          H.fmtDay(a.soldAt) +
          "</div>" +
          (a.soldToBanDays != null
            ? '<span class="chip ' +
              (isBuyer && fast ? "red" : "grey") +
              '">banned ' +
              H.days(a.soldToBanDays) +
              " after</span>"
            : "")
        );
      },
    ],
    [
      "Live listing",
      null,
      function (a) {
        if (!a.liveListings || !a.liveListings.length)
          return '<span class="hint">—</span>';
        return a.liveListings
          .map(function (l) {
            return '<span class="chip red">' + esc(l.marketplace) + "</span>";
          })
          .join(" ");
      },
    ],
    [
      "Creds",
      null,
      function (a) {
        return (
          '<span class="chip ' +
          (a.hasPassword ? "green" : "grey") +
          '">' +
          (a.hasPassword ? "pw" : "no pw") +
          "</span>" +
          (a.credEmail
            ? '<div class="hint mono">' + esc(a.credEmail) + "</div>"
            : "")
        );
      },
    ],
    [
      "Last error",
      null,
      function (a) {
        if (!a.lastScanError) return '<span class="hint">—</span>';
        return (
          '<span class="hint" title="' +
          esc(a.lastScanError) +
          '">' +
          esc(a.lastScanError.slice(0, 60)) +
          (a.lastScanError.length > 60 ? "…" : "") +
          "</span>"
        );
      },
    ],
  ];

  function renderHead() {
    $("headRow").innerHTML = COLUMNS.map(function (c) {
      if (!c[1]) return "<th>" + esc(c[0]) + "</th>";
      var active = state.sort === c[1];
      return (
        '<th class="sortable" data-sort="' +
        c[1] +
        '">' +
        esc(c[0]) +
        ' <span class="arrow">' +
        (active ? (state.dir === "asc" ? "▲" : "▼") : "⇅") +
        "</span></th>"
      );
    }).join("");
  }

  function query() {
    var p = new URLSearchParams();
    p.set("status", $("fStatus").value);
    p.set("source", $("fSource").value);
    if ($("fHost").value) p.set("host", $("fHost").value);
    if ($("fSince").value) p.set("since", $("fSince").value);
    if ($("fSold").value) p.set("sold", $("fSold").value);
    if ($("fSearch").value.trim()) p.set("search", $("fSearch").value.trim());
    p.set("sort", state.sort);
    p.set("dir", state.dir);
    p.set("limit", state.limit);
    p.set("page", state.page);
    return p.toString();
  }

  async function loadAccounts() {
    $("rows").innerHTML =
      '<tr><td class="empty" colspan="' +
      COLUMNS.length +
      '">Loading…</td></tr>';
    try {
      var d = await H.api("/banned/accounts?" + query());
      state.rows = d.accounts || [];
      state.total = d.total || 0;
      renderHead();
      if (!state.rows.length) {
        $("rows").innerHTML =
          '<tr><td class="empty" colspan="' +
          COLUMNS.length +
          '">No accounts match these filters.</td></tr>';
      } else {
        $("rows").innerHTML = state.rows
          .map(function (a) {
            return (
              "<tr>" +
              COLUMNS.map(function (c) {
                return "<td>" + c[2](a) + "</td>";
              }).join("") +
              "</tr>"
            );
          })
          .join("");
      }
      var from = state.total ? (state.page - 1) * state.limit + 1 : 0;
      var to = Math.min(state.page * state.limit, state.total);
      $("pageInfo").textContent =
        num(from) + "–" + num(to) + " of " + num(state.total);
      $("prevBtn").disabled = state.page <= 1;
      $("nextBtn").disabled = state.page * state.limit >= state.total;
    } catch (e) {
      $("rows").innerHTML =
        '<tr><td class="empty" colspan="' +
        COLUMNS.length +
        '">Error: ' +
        esc(e.message) +
        "</td></tr>";
    }
  }

  // Delegated so re-rendered rows keep working without rebinding.
  document.addEventListener("click", function (e) {
    var th = e.target.closest("th.sortable");
    if (th) {
      var key = th.dataset.sort;
      if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
      else {
        state.sort = key;
        state.dir = "desc";
      }
      state.page = 1;
      loadAccounts();
      return;
    }
    var login = e.target.closest(".login");
    if (login && login.dataset.id) openAccount(login.dataset.id);
  });

  $("fSearch").addEventListener("keydown", function (e) {
    if (e.key === "Enter") window.resetAndLoad();
  });

  window.resetAndLoad = function () {
    state.page = 1;
    state.limit = Number($("fLimit").value) || 100;
    loadAccounts();
  };

  window.pageBy = function (d) {
    state.page = Math.max(1, state.page + d);
    loadAccounts();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  };

  window.exportCsv = function () {
    window.location.href =
      "/banned/export.csv?status=" +
      encodeURIComponent($("fStatus").value) +
      "&source=" +
      encodeURIComponent($("fSource").value);
  };

  // Ask Twitch about the accounts currently on screen. Read-only: it reports
  // disagreements, it never rewrites what's stored.
  window.recheckPage = async function () {
    var ids = state.rows.slice(0, 40).map(function (a) {
      return a.id;
    });
    if (!ids.length) return H.toast("Nothing to check", true);
    var btn = $("recheckBtn");
    btn.disabled = true;
    btn.textContent = "Checking " + ids.length + "…";
    try {
      var d = await H.api("/banned/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids }),
      });
      var gone = d.results.filter(function (r) {
        return r.verdict === "gone";
      }).length;
      var alive = d.results.filter(function (r) {
        return r.verdict === "exists";
      }).length;
      var unknown = d.results.filter(function (r) {
        return r.verdict === "unknown";
      }).length;
      H.toast(
        "Twitch says: " +
          gone +
          " gone, " +
          alive +
          " still alive, " +
          unknown +
          " unknown" +
          (d.disagreements
            ? " — " + d.disagreements + " filed as banned are still live!"
            : ""),
        d.disagreements > 0,
      );
    } catch (e) {
      H.toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Re-check with Twitch";
    }
  };

  // ----------------------------------------------------------------
  // Drill-down
  // ----------------------------------------------------------------
  function kv(label, value) {
    return (
      "<div><b>" +
      esc(label) +
      "</b><span>" +
      (value == null || value === "" ? "—" : value) +
      "</span></div>"
    );
  }

  async function openAccount(id) {
    var modal = $("modal");
    $("modalBox").innerHTML = '<div class="hint">Loading…</div>';
    modal.classList.add("show");
    try {
      var d = await H.api("/banned/account/" + id);
      var a = d.account;
      var html =
        '<button class="close" onclick="closeModal()">Close</button>' +
        "<h3>" +
        esc(a.login || "(no login)") +
        "</h3>" +
        '<div class="hint">' +
        (a.status === "suspended"
          ? "Confirmed gone from Twitch"
          : "Status: " + esc(a.status)) +
        (a.suspendedAt ? " on " + H.fmtDate(a.suspendedAt) : "") +
        "</div>";

      html += '<div class="kv">';
      html += kv("Twitch id", esc(a.twitchId));
      html += kv("Host", esc(a.host));
      html += kv("Config file", esc(a.configFile));
      html += kv("Container", esc(a.container));
      html += kv("Added to rig", H.fmtDate(a.createdAt));
      html += kv("Banned", a.suspendedAt ? H.fmtDate(a.suspendedAt) : "—");
      html += kv(
        "Survived",
        a.suspendedAt && a.createdAt
          ? H.days((new Date(a.suspendedAt) - new Date(a.createdAt)) / 86400000)
          : "—",
      );
      html += kv("Last scan", H.fmtDate(a.lastScanAt));
      html += kv("Drops recorded", num(a.dropCount));
      html += kv(
        "In progress",
        num(a.inProgressCount) +
          (a.inProgressGames && a.inProgressGames.length
            ? " (" + esc(a.inProgressGames.join(", ")) + ")"
            : ""),
      );
      html += kv("Enabled", a.enabled ? "yes" : "no");
      html += kv(
        "Credentials",
        (a.hasPassword ? "password stored" : "no password") +
          (a.credUsername ? " · " + esc(a.credUsername) : ""),
      );
      html += kv("Email", esc(a.credEmail));
      html += kv(
        "Copied to buyer",
        num(a.copiedCount) +
          (a.lastCopiedAt ? " · " + H.fmtDay(a.lastCopiedAt) : ""),
      );
      if (a.soldAt) {
        html += kv(
          "Sold",
          H.fmtDate(a.soldAt) +
            (a.soldToUsername ? " to " + esc(a.soldToUsername) : ""),
        );
      }
      html += "</div>";

      if (a.lastScanError) {
        html +=
          '<div class="hint" style="padding:10px;background:var(--surface-2);border-radius:9px;margin-bottom:14px"><b>Last scan error:</b><br>' +
          esc(a.lastScanError) +
          "</div>";
      }

      // How the rest of this account's config file fared — the fastest way to
      // tell "this container got swept" from "this one account got unlucky".
      if (d.configPeers && d.configPeers.length) {
        html +=
          "<h3 style='font-size:14px;margin:16px 0 6px'>Rest of " +
          esc(a.configFile || "this config") +
          "</h3><div>";
        d.configPeers.forEach(function (p) {
          var cls =
            p.status === "ok"
              ? "green"
              : p.status === "suspended"
                ? "red"
                : "amber";
          html +=
            '<span class="chip ' +
            cls +
            '" style="margin-right:6px">' +
            esc(p.status) +
            ": " +
            num(p.n) +
            "</span>";
        });
        html += "</div>";
      }

      if (d.listings && d.listings.length) {
        html += "<h3 style='font-size:14px;margin:16px 0 6px'>Listings</h3>";
        html +=
          '<div class="tablewrap" style="max-height:200px"><table><thead><tr><th>Marketplace</th><th>Title</th><th>Status</th><th>Price</th></tr></thead><tbody>';
        d.listings.forEach(function (l) {
          html +=
            "<tr><td>" +
            esc(l.marketplace) +
            "</td><td>" +
            (l.url
              ? '<a href="' +
                esc(l.url) +
                '" target="_blank" rel="noopener">' +
                esc(l.title || l.url) +
                "</a>"
              : esc(l.title || "—")) +
            '</td><td><span class="chip ' +
            (l.status === "active" ? "red" : "grey") +
            '">' +
            esc(l.status) +
            "</span></td><td>" +
            (l.price || "—") +
            "</td></tr>";
        });
        html += "</tbody></table></div>";
      }

      if (d.drops && d.drops.length) {
        html +=
          "<h3 style='font-size:14px;margin:16px 0 6px'>Drops it held (" +
          num(d.drops.length) +
          ")</h3>";
        html +=
          '<div class="tablewrap" style="max-height:260px"><table><thead><tr><th>Drop</th><th>Game</th><th>Awarded</th><th>Sold</th></tr></thead><tbody>';
        d.drops.forEach(function (dr) {
          html +=
            "<tr><td>" +
            esc(dr.name || "—") +
            "</td><td>" +
            esc(dr.game || "—") +
            "</td><td>" +
            H.fmtDay(dr.awardedAt) +
            "</td><td>" +
            (dr.soldAt ? H.fmtDay(dr.soldAt) : "—") +
            "</td></tr>";
        });
        html += "</tbody></table></div>";
      } else {
        html +=
          '<div class="hint" style="margin-top:14px">No drops recorded against this account.</div>';
      }

      $("modalBox").innerHTML = html;
    } catch (e) {
      $("modalBox").innerHTML =
        '<button class="close" onclick="closeModal()">Close</button><div class="hint">Error: ' +
        esc(e.message) +
        "</div>";
    }
  }

  window.closeModal = function () {
    $("modal").classList.remove("show");
  };
  window.closeModalOutside = function (e) {
    if (e.target && e.target.id === "modal") window.closeModal();
  };
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") window.closeModal();
  });

  // Facets come from the data so the host list can't drift out of sync.
  (async function boot() {
    try {
      var f = await H.api("/banned/facets");
      (f.hosts || []).forEach(function (h) {
        var o = document.createElement("option");
        o.value = h;
        o.textContent = h;
        $("fHost").appendChild(o);
      });
    } catch (e) {}
    window.loadSummary();
    H.loadExposure();
    H.loadAnalytics();
    loadAccounts();
  })();
})();
