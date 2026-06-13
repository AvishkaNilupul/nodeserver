// Role-aware navigation. The real access control lives on the server; this
// just hides links the current admin isn't allowed to use and surfaces the
// superadmin-only "Admins" link.
(function () {
  var SUPERADMIN_LINKS = ["twitch-inventory.html", "bots.html"];

  function marketplaceLinkMarkup() {
    return (
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M3 3h18l-2 5H5L3 3z"></path>' +
      '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>' +
      '<path d="M9 13h6"></path></svg> Marketplace'
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

  function run() {
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
