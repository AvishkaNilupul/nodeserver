// Role-aware navigation. The real access control lives on the server; this
// just hides links the current admin isn't allowed to use and surfaces the
// superadmin-only "Admins" link.
(function () {
  var SUPERADMIN_LINKS = [
    "twitch-inventory.html",
    "bots.html",
    "drops-archive.html",
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

  function dropsArchiveLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M21 8v13H3V8"></path>' +
      '<path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg> ' +
      "Drops archive"
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
