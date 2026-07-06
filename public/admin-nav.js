// Role-aware navigation. The real access control lives on the server; this
// just hides links the current admin isn't allowed to use and surfaces the
// superadmin-only "Admins" link.
(function () {
  var SUPERADMIN_LINKS = [
    "twitch-inventory.html",
    "bots.html",
    "drops-archive.html",
    "listings.html",
    "integrity.html",
    "backup.html",
  ];

  function marketplaceLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M3 3h18l-2 5H5L3 3z"></path>' +
      '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>' +
      '<path d="M9 13h6"></path></svg> Marketplace'
    );
  }

  function shopLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle>' +
      '<circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 ' +
      '2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg> Shop'
    );
  }

  function dropsArchiveLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M21 8v13H3V8"></path>' +
      '<path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg> ' +
      "Drops archive"
    );
  }

  function listingsLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 ' +
      '4 1.5-7.5L2 9h7z"></path></svg> Listings'
    );
  }

  function settingsLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83' +
      "l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1" +
      "-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 " +
      "1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3" +
      "a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06" +
      "-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 " +
      "0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82" +
      "-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 " +
      '1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
      "</svg> Settings"
    );
  }

  function integrityLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 ' +
      '10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg> Integrity'
    );
  }

  function backupLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3">' +
      '</ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>' +
      '<path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg> Backup'
    );
  }

  function adminsLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0' +
      '-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v' +
      '-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path></svg> Admins'
    );
  }

  function apply(admin) {
    var isSuper = admin && admin.role === "superadmin";
    var links = document.querySelector(".nav .links");
    if (!links) {
      return;
    }

    links.querySelectorAll("a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var restricted = SUPERADMIN_LINKS.some(function (name) {
        return href.indexOf(name) !== -1;
      });
      if (restricted && !isSuper) {
        a.remove();
      }
    });

    // Settings hosts both 2FA (security) and per-admin preferences (e.g.
    // Telegram linking) — available to every admin.
    if (links.querySelector('a[href="/security.html"]')) {
      links.querySelector('a[href="/security.html"]').remove();
    }
    if (!links.querySelector('a[href="/settings.html"]')) {
      var setlink = document.createElement("a");
      setlink.href = "/settings.html";
      setlink.innerHTML = settingsLinkMarkup();
      if (window.location.pathname === "/settings.html") {
        setlink.className = "active";
      }
      links.appendChild(setlink);
    }

    // Marketplace is available to every admin (normal + superadmin).
    if (!links.querySelector('a[href="/marketplace.html"]')) {
      var mlink = document.createElement("a");
      mlink.href = "/marketplace.html";
      mlink.innerHTML = marketplaceLinkMarkup();
      if (window.location.pathname === "/marketplace.html") {
        mlink.className = "active";
      }
      links.appendChild(mlink);
    }

    // Shop (in-app bundle store) — available to every admin.
    if (!links.querySelector('a[href="/shop.html"]')) {
      var shlink = document.createElement("a");
      shlink.href = "/shop.html";
      shlink.innerHTML = shopLinkMarkup();
      if (window.location.pathname === "/shop.html") {
        shlink.className = "active";
      }
      links.appendChild(shlink);
    }

    // Drops archive (superadmin only). Inserted next to the Bots/Twitch links
    // when present so related tools stay grouped, otherwise appended.
    if (isSuper && !links.querySelector('a[href="/drops-archive.html"]')) {
      var dlink = document.createElement("a");
      dlink.href = "/drops-archive.html";
      dlink.innerHTML = dropsArchiveLinkMarkup();
      if (window.location.pathname === "/drops-archive.html") {
        dlink.className = "active";
      }
      var anchor =
        links.querySelector('a[href="/bots.html"]') ||
        links.querySelector('a[href="/twitch-inventory.html"]');
      if (anchor && anchor.nextSibling) {
        links.insertBefore(dlink, anchor.nextSibling);
      } else if (anchor) {
        links.appendChild(dlink);
      } else {
        links.appendChild(dlink);
      }
    }

    // Listings manager (superadmin only) — grouped right after Drops archive.
    if (isSuper && !links.querySelector('a[href="/listings.html"]')) {
      var llink = document.createElement("a");
      llink.href = "/listings.html";
      llink.innerHTML = listingsLinkMarkup();
      if (window.location.pathname === "/listings.html") {
        llink.className = "active";
      }
      var dropsAnchor = links.querySelector('a[href="/drops-archive.html"]');
      if (dropsAnchor && dropsAnchor.nextSibling) {
        links.insertBefore(llink, dropsAnchor.nextSibling);
      } else {
        links.appendChild(llink);
      }
    }

    // Integrity guard (superadmin only) — grouped right after Listings.
    if (isSuper && !links.querySelector('a[href="/integrity.html"]')) {
      var ilink = document.createElement("a");
      ilink.href = "/integrity.html";
      ilink.innerHTML = integrityLinkMarkup();
      if (window.location.pathname === "/integrity.html") {
        ilink.className = "active";
      }
      var listAnchor0 = links.querySelector('a[href="/listings.html"]');
      if (listAnchor0 && listAnchor0.nextSibling) {
        links.insertBefore(ilink, listAnchor0.nextSibling);
      } else {
        links.appendChild(ilink);
      }
    }

    // Backup & restore (superadmin only) — grouped right after Integrity.
    if (isSuper && !links.querySelector('a[href="/backup.html"]')) {
      var blink = document.createElement("a");
      blink.href = "/backup.html";
      blink.innerHTML = backupLinkMarkup();
      if (window.location.pathname === "/backup.html") {
        blink.className = "active";
      }
      var listAnchor =
        links.querySelector('a[href="/integrity.html"]') ||
        links.querySelector('a[href="/listings.html"]');
      if (listAnchor && listAnchor.nextSibling) {
        links.insertBefore(blink, listAnchor.nextSibling);
      } else {
        links.appendChild(blink);
      }
    }

    if (isSuper && !links.querySelector('a[href="/superadmin.html"]')) {
      var link = document.createElement("a");
      link.href = "/superadmin.html";
      link.innerHTML = adminsLinkMarkup();
      if (window.location.pathname === "/superadmin.html") {
        link.className = "active";
      }
      links.appendChild(link);
    }

    var roleEl = document.getElementById("meRole");
    if (roleEl) {
      var label = isSuper ? "Super Admin" : "Seller";
      roleEl.innerText =
        label + (admin && admin.id ? " \u00b7 " + admin.id : "");
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
    nav.querySelectorAll(".links a").forEach(function (a) {
      a.addEventListener("click", close);
    });
  }

  function run() {
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
