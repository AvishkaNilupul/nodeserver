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
    catalog:
      '<path d="M4 6h16M4 12h16M4 18h10"></path>' +
      '<circle cx="19" cy="18" r="2"></circle>',
    dropsArchive:
      '<path d="M21 8v13H3V8"></path>' +
      '<path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path>',
    listings:
      '<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"></path>',
    bulkOrders:
      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 ' +
      '8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>' +
      '<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>' +
      '<line x1="12" y1="22.08" x2="12" y2="12"></line>',
    renters:
      '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 ' +
      '7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',
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
    research:
      '<path d="M3 3v18h18"></path>' + '<path d="M7 13l4-4 3 3 5-6"></path>',
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
    banned:
      '<circle cx="12" cy="12" r="10"></circle>' +
      '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>',
    chevron: '<path d="M9 18l6-6-6-6"></path>',
    aiChat:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 ' +
      '2z"></path><path d="M9.5 9.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"></path>',
    proposals:
      '<path d="M9 11l3 3L22 4"></path>' +
      '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
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
          href: "/farm2.html",
          label: "Auto farm engine",
          icon:
            '<path d="M3 6h18M3 12h18M3 18h18"></path>' +
            '<circle cx="7" cy="6" r="1.6"></circle>' +
            '<circle cx="13" cy="12" r="1.6"></circle>' +
            '<circle cx="9" cy="18" r="1.6"></circle>',
          superOnly: true,
        },
        {
          href: "/farm-sizing.html",
          label: "Fleet sizing",
          icon:
            '<path d="M3 20V10M9 20V4M15 20v-7M21 20v-11"></path>',
          superOnly: true,
        },
        {
          href: "/unclaimed-farms.html",
          label: "Unclaimed farms",
          icon:
            '<path d="M12 2v6M12 22v-6M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M2 ' +
            '12h6M22 12h-6M4.9 19.1l4.2-4.2M14.9 9.1l4.2-4.2"></path>',
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
        {
          href: "/spent-accounts.html",
          label: "Spent accounts",
          icon: ICONS.accountPool,
          superOnly: true,
        },
        {
          href: "/banned-accounts.html",
          label: "Banned accounts",
          icon: ICONS.banned,
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
          href: "/catalog-admin.html",
          label: "Public catalog",
          icon: ICONS.catalog,
          superOnly: true,
        },
        {
          href: "/listings.html",
          label: "Listings",
          icon: ICONS.listings,
          superOnly: true,
        },
        {
          href: "/playerauctions.html",
          label: "PlayerAuctions",
          icon: ICONS.listings,
          superOnly: true,
        },
        {
          href: "/bulk-orders.html",
          label: "Bulk orders",
          icon: ICONS.bulkOrders,
          superOnly: true,
        },
        {
          href: "/integrity.html",
          label: "Integrity",
          icon: ICONS.integrity,
          superOnly: true,
        },
        {
          href: "/research.html",
          label: "Market research",
          icon: ICONS.research,
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
          href: "/system-health.html",
          label: "System health",
          // A heartbeat, matching the activity log's pulse line beside it —
          // these two are the pair you open when something feels wrong.
          icon:
            '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>',
          superOnly: true,
        },
        {
          href: "/market-console.html",
          label: "Marketplace console",
          // Sits between health and the activity log on purpose: health says
          // whether something is wrong, this says what a marketplace actually
          // sold, sent and made, and the activity log is the raw feed.
          icon:
            '<path d="M3 3h18l-2 5H5L3 3z"></path>' +
            '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>' +
            '<path d="M9 13h6"></path>',
          superOnly: true,
        },
        {
          href: "/activity.html",
          label: "Activity log",
          icon: '<path d="M3 12h4l3 8 4-16 3 8h4"></path>',
          superOnly: true,
        },
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
    {
      key: "renting",
      label: "Renting",
      icon: ICONS.renters,
      items: [
        {
          href: "/renters.html",
          label: "Renters",
          icon: ICONS.renters,
          superOnly: true,
        },
        {
          href: "/resellers.html",
          label: "Resellers",
          icon: ICONS.renters,
          superOnly: true,
        },
      ],
    },
  ];
  var STANDALONE = [
    {
      href: "/ai-chat.html",
      label: "AI Chat",
      icon: ICONS.aiChat,
      superOnly: false,
    },
    {
      href: "/ai-proposals.html",
      label: "Coworker proposals",
      icon: ICONS.proposals,
      superOnly: true,
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

    // The menu is a 0fr/1fr grid so opening and closing can animate; the
    // links live in an inner track so the group's padding and rule line
    // collapse with it instead of leaving a sliver behind when closed.
    var menu = document.createElement("div");
    menu.className = "nav-group-menu";
    var inner = document.createElement("div");
    inner.className = "nav-group-menu-inner";
    menu.appendChild(inner);

    var hasActive = false;
    items.forEach(function (it) {
      var a = buildLink(it);
      if (a.className === "active") hasActive = true;
      inner.appendChild(a);
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
    // Telegram linking) — available to every admin. Standalone links honor
    // superOnly the same way grouped items do (e.g. Guides).
    STANDALONE.forEach(function (item) {
      if (item.superOnly && !isSuper) return;
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

    // The group holding the current page is expanded above, so settle the
    // sidebar in its final shape first, then let later toggles animate.
    revealActiveLink();
    var nav = links.closest(".nav");
    if (nav) {
      requestAnimationFrame(function () {
        nav.classList.add("nav-anim");
      });
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
      // Lock the page underneath, or a flick that runs past the end of the
      // menu carries on scrolling the content behind the drawer.
      document.documentElement.classList.add("nav-drawer-open");
    }
    function close() {
      nav.classList.remove("open");
      backdrop.classList.remove("show");
      document.documentElement.classList.remove("nav-drawer-open");
    }
    bar.querySelector(".hamburger").addEventListener("click", open);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) close();
    });
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
      ".nav-group-menu{display:grid;grid-template-rows:0fr;overflow:hidden;}" +
      ".nav-group.open>.nav-group-menu{grid-template-rows:1fr;}" +
      // Vertical padding only while open — a 0fr track can't shrink below its
      // item's padding, so leaving it on would keep every closed group a few
      // pixels tall and leave a stub of the rule line behind.
      ".nav-group-menu-inner{min-height:0;overflow:hidden;display:flex;" +
      "flex-direction:column;gap:2px;padding:0 0 0 21px;" +
      "border-left:1px solid var(--line);margin-left:24px;}" +
      ".nav-group.open>.nav-group-menu>.nav-group-menu-inner{padding-top:2px;" +
      "padding-bottom:4px;}" +
      ".nav-group-menu a{font-size:13.5px;padding:8px 10px;}" +
      ".nav-group-menu a svg{width:15px;height:15px;flex-shrink:0;}" +
      // Only animate once the sidebar has painted, so the group holding the
      // current page doesn't slide open every single navigation.
      ".nav.nav-anim .nav-group-menu{transition:grid-template-rows .18s ease;}" +
      ".nav.nav-anim .nav-group-menu-inner{transition:padding .18s ease;}" +
      "@media (prefers-reduced-motion:reduce){" +
      ".nav.nav-anim .nav-group-menu,.nav.nav-anim .nav-group-menu-inner{" +
      "transition:none;}" +
      ".nav-group-toggle .chev{transition:none;}}" +
      navScrollCss();
    var style = document.createElement("style");
    style.id = "nav-group-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Sidebar scrolling.
  //
  // Every page writes its own ".nav" styles, and almost all of them left the
  // link list with no scroll container of its own. Once the dropdown groups
  // are expanded the list is far taller than the sidebar — on a 1280x800
  // screen roughly 650-960px of it lands past the bottom edge — and because
  // the pages that pin the sidebar to the viewport also lock the document
  // (body{height:100vh;overflow:hidden}) or pin it with position:sticky,
  // there is no scroll anywhere in the chain that can bring those links back.
  // The wheel does nothing, touch does nothing: the bottom of the menu is
  // simply unreachable.
  //
  // These rules give the list its own scroll region on every page and pin the
  // sidebars the page left in normal flow so they stop sliding away with the
  // main column. They are qualified by class so they outrank each page's own
  // ".nav .links" rules no matter which stylesheet came first.
  function navScrollCss() {
    return (
      ".nav.nav-scroll{overflow:hidden;}" +
      ".nav.nav-scroll>.brand,.nav.nav-scroll>.me{flex-shrink:0;}" +
      ".nav.nav-scroll>.links{flex:1 1 auto;min-height:0;overflow-y:auto;" +
      "overflow-x:hidden;overscroll-behavior:contain;" +
      "-webkit-overflow-scrolling:touch;scrollbar-width:thin;" +
      "scrollbar-color:var(--line) transparent;}" +
      ".nav.nav-scroll>.links::-webkit-scrollbar{width:8px;}" +
      ".nav.nav-scroll>.links::-webkit-scrollbar-track{background:transparent;}" +
      ".nav.nav-scroll>.links::-webkit-scrollbar-thumb{border-radius:8px;" +
      "background:var(--line);border:2px solid transparent;background-clip:content-box;}" +
      ".nav.nav-scroll>.links:hover::-webkit-scrollbar-thumb{background:var(--muted);" +
      "background-clip:content-box;}" +
      // Desktop only: mobile turns .nav into a fixed off-canvas drawer, which
      // already spans the viewport and must not be re-positioned here.
      "@media (min-width:769px){" +
      ".nav.nav-scroll{max-height:100vh;max-height:100dvh;}" +
      ".nav.nav-pin{position:sticky;top:0;align-self:flex-start;" +
      "height:100vh;height:100dvh;}}" +
      // Holding the drawer open shouldn't let the page behind it scroll.
      "@media (max-width:768px){" +
      "html.nav-drawer-open,html.nav-drawer-open body{overflow:hidden;}}"
    );
  }

  // Give the sidebar its scroll region, and pin it if the page left it in
  // normal flow. Read the position before any of our own CSS is injected:
  // the mobile drawer rules below make every .nav position:fixed, which would
  // otherwise hide whether the page itself wanted a flow-positioned sidebar.
  function markNavScroll() {
    var nav = document.querySelector(".nav");
    if (!nav) return;
    var pos = window.getComputedStyle(nav).position;
    nav.classList.add("nav-scroll");
    if (pos === "static" || pos === "relative") {
      nav.classList.add("nav-pin");
    }
  }

  // Bring the current page's link into view when it sits below the fold of a
  // scrolled sidebar — scrolling the list itself (never the page), and only
  // as far as it takes, so the top of the menu stays put whenever it already
  // fits.
  function revealActiveLink() {
    var links = document.querySelector(".nav .links");
    if (!links) return;
    var active = links.querySelector("a.active");
    if (!active || links.scrollHeight <= links.clientHeight + 1) return;

    var pad = 12; // don't leave the link flush against the edge
    var top = active.offsetTop - links.offsetTop;
    var bottom = top + active.offsetHeight;
    if (bottom + pad > links.scrollTop + links.clientHeight) {
      links.scrollTop = bottom + pad - links.clientHeight;
    } else if (top - pad < links.scrollTop) {
      links.scrollTop = Math.max(0, top - pad);
    }
  }

  function run() {
    // Before anything of ours is injected, so the sidebar's own position is
    // still what the page's stylesheet says it is.
    markNavScroll();
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
