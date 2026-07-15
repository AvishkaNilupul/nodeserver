// Role-aware navigation. The real access control lives on the server; this
// just hides links the current admin isn't allowed to use, groups the
// feature-area links into collapsible dropdowns so the sidebar doesn't grow
// one flat link per feature forever, and surfaces the superadmin-only
// "Admins" link.
(function () {
  function icon(pathHtml) {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round">' +
      pathHtml +
      "</svg>"
    );
  }

  var ICONS = {
    marketplace:
      '<path d="M3 3h18l-2 5H5L3 3z"></path>' +
      '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>' +
      '<path d="M9 13h6"></path>',
    shop:
      '<circle cx="9" cy="21" r="1"></circle>' +
      '<circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 ' +
      '2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>',
    dropsArchive:
      '<path d="M21 8v13H3V8"></path>' +
      '<path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path>',
    listings:
      '<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"></path>',
    settings:
      '<circle cx="12" cy="12" r="3"></circle>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83' +
      "l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1" +
      "-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 " +
      "1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3" +
      "a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06" +
      "-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 " +
      "0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82" +
      "-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 " +
      '1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
    integrity:
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 ' +
      '10 8 10z"></path><path d="M9 12l2 2 4-4"></path>',
    prime:
      '<polyline points="20 12 20 22 4 22 4 12"></polyline>' +
      '<rect x="2" y="7" width="20" height="5"></rect>' +
      '<line x1="12" y1="22" x2="12" y2="7"></line>' +
      '<path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path>' +
      '<path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path>',
    radar:
      '<circle cx="12" cy="12" r="2"></circle>' +
      '<path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49">' +
      '</path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 ' +
      '0 1 0-14.14"></path>',
    epicAccounts:
      '<rect x="2" y="4" width="20" height="16" ' +
      'rx="2"></rect><path d="M2 10h20"></path><path d="M6 15h4"></path>',
    backup:
      '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>' +
      '<path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>' +
      '<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>',
    admins:
      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0' +
      '-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v' +
      '-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>',
    twitchDrops:
      '<rect x="2" y="4" width="20" height="14" rx="2"></rect>' +
      '<path d="M8 21h8M12 18v3M7 8h.01M11 8h2"></path>',
    bots:
      '<rect x="4" y="8" width="16" height="12" rx="2"></rect>' +
      '<path d="M12 8V5M9 3h6M9 14h.01M15 14h.01M2 13h2M20 13h2"></path>',
    accountPool:
      '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    chevron: '<path d="M9 18l6-6-6-6"></path>',
    japanese:
      '<path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 ' +
      '1 0 0 1-1-1v-2"></path><path d="M8 4v16"></path>' +
      '<path d="M11 9h6M14 9v6M11 14h6"></path>',
  };

  // Every href this script manages (either as a standalone link or grouped
  // into a dropdown), so a re-run — or a page whose static markup already
  // has one of these baked in — can be normalized to one consistent place
  // instead of ending up duplicated or stuck in a different spot per page.
  var GROUPS = [
    {
      key: "bots",
      label: "Bots",
      icon: ICONS.bots,
      items: [
        {
          href: "/twitch-inventory.html",
          label: "Twitch drops",
          icon: ICONS.twitchDrops,
          superOnly: true,
        },
        {
          href: "/bots.html",
          label: "Bots",
          icon: ICONS.bots,
          superOnly: true,
        },
        {
          href: "/drops-archive.html",
          label: "Drops archive",
          icon: ICONS.dropsArchive,
          superOnly: true,
        },
        {
          href: "/account-pool.html",
          label: "Account pool",
          icon: ICONS.accountPool,
          superOnly: true,
        },
      ],
    },
    {
      key: "marketplace",
      label: "Marketplace",
      icon: ICONS.marketplace,
      items: [
        {
          href: "/marketplace.html",
          label: "Marketplace",
          icon: ICONS.marketplace,
          superOnly: false,
        },
        {
          href: "/shop.html",
          label: "Shop",
          icon: ICONS.shop,
          superOnly: false,
        },
        {
          href: "/listings.html",
          label: "Listings",
          icon: ICONS.listings,
          superOnly: true,
        },
        {
          href: "/integrity.html",
          label: "Integrity",
          icon: ICONS.integrity,
          superOnly: true,
        },
      ],
    },
    {
      key: "watchers",
      label: "Watchers",
      icon: ICONS.radar,
      items: [
        {
          href: "/prime.html",
          label: "Prime Gaming",
          icon: ICONS.prime,
          superOnly: true,
        },
        {
          href: "/radar.html",
          label: "Drops radar",
          icon: ICONS.radar,
          superOnly: true,
        },
        {
          href: "/epic-accounts.html",
          label: "Epic accounts",
          icon: ICONS.epicAccounts,
          superOnly: true,
        },
      ],
    },
    {
      key: "admin",
      label: "Admin",
      icon: ICONS.admins,
      items: [
        {
          href: "/backup.html",
          label: "Backup",
          icon: ICONS.backup,
          superOnly: true,
        },
        {
          href: "/superadmin.html",
          label: "Admins",
          icon: ICONS.admins,
          superOnly: true,
        },
      ],
    },
  ];
  var STANDALONE = [
    {
      href: "/japanese.html",
      label: "Japanese N5",
      icon: ICONS.japanese,
      superOnly: false,
    },
    {
      href: "/settings.html",
      label: "Settings",
      icon: ICONS.settings,
      superOnly: false,
    },
  ];
  var ALL_MANAGED_HREFS = STANDALONE.map(function (s) {
    return s.href;
  }).concat(
    GROUPS.reduce(function (acc, g) {
      return acc.concat(
        g.items.map(function (it) {
          return it.href;
        }),
      );
    }, []),
  );

  function buildLink(item) {
    var a = document.createElement("a");
    a.href = item.href;
    a.innerHTML = icon(item.icon) + " " + item.label;
    if (window.location.pathname === item.href) {
      a.className = "active";
    }
    return a;
  }

  function buildGroup(group, isSuper) {
    var items = group.items.filter(function (it) {
      return !it.superOnly || isSuper;
    });
    if (!items.length) return null;

    var wrap = document.createElement("div");
    wrap.className = "nav-group";
    wrap.dataset.group = group.key;

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "nav-group-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML =
      icon(group.icon) +
      " <span>" +
      group.label +
      "</span>" +
      '<span class="chev">' +
      icon(ICONS.chevron) +
      "</span>";

    var menu = document.createElement("div");
    menu.className = "nav-group-menu";

    var hasActive = false;
    items.forEach(function (it) {
      var a = buildLink(it);
      if (a.className === "active") hasActive = true;
      menu.appendChild(a);
    });

    if (hasActive) {
      wrap.classList.add("open", "has-active");
      toggle.setAttribute("aria-expanded", "true");
    }

    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    return wrap;
  }

  function apply(admin) {
    var isSuper = admin && admin.role === "superadmin";
    var links = document.querySelector(".nav .links");
    if (!links) {
      return;
    }

    // Drop any previously-rendered groups (a re-run of apply() shouldn't
    // duplicate them) and any raw <a> — static markup or leftover from an
    // older flat-link version of this script — for hrefs we now manage
    // ourselves, so every page ends up with exactly one consistent copy.
    links.querySelectorAll(".nav-group").forEach(function (g) {
      g.remove();
    });
    links.querySelectorAll("a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href === "/security.html" || ALL_MANAGED_HREFS.indexOf(href) !== -1) {
        a.remove();
      }
    });

    // Settings hosts both 2FA (security) and per-admin preferences (e.g.
    // Telegram linking) — available to every admin.
    STANDALONE.forEach(function (item) {
      links.appendChild(buildLink(item));
    });

    GROUPS.forEach(function (group) {
      var el = buildGroup(group, isSuper);
      if (el) links.appendChild(el);
    });

    // Delegate the toggle click once — rebuilding the groups above replaces
    // their DOM nodes each run, but the listener lives on the stable
    // container so it doesn't need to be re-attached per link.
    if (!links.dataset.groupToggleBound) {
      links.dataset.groupToggleBound = "1";
      links.addEventListener("click", function (e) {
        var btn = e.target.closest(".nav-group-toggle");
        if (!btn) return;
        var group = btn.closest(".nav-group");
        var open = group.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    var roleEl = document.getElementById("meRole");
    if (roleEl) {
      var label = isSuper ? "Super Admin" : "Seller";
      roleEl.innerText = label + (admin && admin.id ? " · " + admin.id : "");
    }
  }

  // Mobile navigation: on small screens the left sidebar becomes an
  // off-canvas drawer opened from a top bar with a hamburger button. Injected
  // here so every admin page that loads this script gets it for free.
  function setupMobileNav() {
    var nav = document.querySelector(".nav");
    if (!nav || document.querySelector(".mobile-topbar")) {
      return;
    }

    var css =
      ".mobile-topbar{display:none;}" +
      ".nav-backdrop{display:none;}" +
      "@media (max-width:768px){" +
      "body{padding-top:54px;}" +
      ".mobile-topbar{display:flex;align-items:center;gap:12px;position:fixed;" +
      "top:0;left:0;right:0;height:54px;z-index:160;background:var(--surface);" +
      "border-bottom:1px solid var(--line);padding:0 14px;}" +
      ".mobile-topbar b{font-size:15px;font-weight:700;color:var(--ink);}" +
      ".mobile-topbar .hamburger{width:40px;height:40px;border-radius:10px;" +
      "border:1px solid var(--line);background:var(--surface);color:var(--ink);" +
      "display:grid;place-items:center;cursor:pointer;flex-shrink:0;}" +
      ".nav{position:fixed;top:0;left:0;bottom:0;z-index:200;width:264px;" +
      "transform:translateX(-100%);transition:transform .25s ease;" +
      "box-shadow:0 0 50px rgba(15,23,42,.3);}" +
      ".nav.open{transform:translateX(0);}" +
      ".nav-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);" +
      "z-index:180;}" +
      ".nav-backdrop.show{display:block;}" +
      "}";
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var bar = document.createElement("div");
    bar.className = "mobile-topbar";
    bar.innerHTML =
      '<button class="hamburger" type="button" aria-label="Menu">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M3 6h18M3 12h18M3 18h18"></path></svg></button>' +
      "<b>RedeemHub</b>";

    var backdrop = document.createElement("div");
    backdrop.className = "nav-backdrop";

    document.body.insertBefore(bar, document.body.firstChild);
    document.body.appendChild(backdrop);

    function open() {
      nav.classList.add("open");
      backdrop.classList.add("show");
    }
    function close() {
      nav.classList.remove("open");
      backdrop.classList.remove("show");
    }
    bar.querySelector(".hamburger").addEventListener("click", open);
    backdrop.addEventListener("click", close);
    // Delegated (not per-link) so links added dynamically by apply() —
    // including everything inside the dropdown groups — are covered without
    // needing their own listener. A group's toggle button is intentionally
    // not an <a>, so tapping it to expand/collapse never closes the drawer.
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) close();
    });
  }

  // Dropdown-group chrome. Everything else the nav needs (link colors,
  // hover, .active background) already comes from each page's own inline
  // "<aside class=\"nav\">" styles via plain ".nav .links a" rules, which
  // match these nested links too since they're still descendants of .links.
  function injectGroupCss() {
    if (document.getElementById("nav-group-style")) return;
    var css =
      ".nav-group{display:flex;flex-direction:column;}" +
      ".nav-group-toggle{display:flex;align-items:center;gap:11px;width:100%;" +
      "padding:11px 13px;border-radius:10px;border:none;background:transparent;" +
      "color:var(--muted);font:inherit;font-size:14px;font-weight:500;" +
      "cursor:pointer;text-align:left;}" +
      ".nav-group-toggle:hover{background:var(--surface-2);}" +
      ".nav-group-toggle span:first-of-type{flex:1;}" +
      ".nav-group-toggle .chev{display:flex;flex-shrink:0;transition:transform .15s ease;}" +
      ".nav-group-toggle .chev svg{width:14px;height:14px;}" +
      ".nav-group.open>.nav-group-toggle .chev{transform:rotate(90deg);}" +
      ".nav-group.has-active>.nav-group-toggle{color:var(--accent);font-weight:600;}" +
      ".nav-group-menu{display:none;flex-direction:column;gap:2px;" +
      "padding:2px 0 4px 21px;border-left:1px solid var(--line);margin-left:24px;}" +
      ".nav-group.open>.nav-group-menu{display:flex;}" +
      ".nav-group-menu a{font-size:13.5px;padding:8px 10px;}" +
      ".nav-group-menu a svg{width:15px;height:15px;flex-shrink:0;}";
    var style = document.createElement("style");
    style.id = "nav-group-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function run() {
    injectGroupCss();
    setupMobileNav();
    fetch("/whoami", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) {
          window.location.href = "/admin-login.html";
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (data) {
          apply((data && data.admin) || {});
        }
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
