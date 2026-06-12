// Shared light/dark theme controller for RedeemHub.
// Theme is stored per-browser in localStorage and applied to <html data-theme>.
(function () {
  function current() {
    try {
      return localStorage.getItem("theme") === "dark" ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  function sync() {
    var dark = current() === "dark";
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      var b = toggles[i];
      b.setAttribute("aria-pressed", dark ? "true" : "false");
      var label = b.querySelector(".t-label");
      if (label) label.textContent = dark ? "Light mode" : "Dark mode";
      var sun = b.querySelector(".t-sun");
      var moon = b.querySelector(".t-moon");
      if (sun) sun.style.display = dark ? "" : "none";
      if (moon) moon.style.display = dark ? "none" : "";
    }
  }

  window.toggleTheme = function () {
    var next = current() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", next);
    } catch (e) {}
    apply(next);
    sync();
  };

  apply(current());
  if (document.readyState !== "loading") sync();
  else document.addEventListener("DOMContentLoaded", sync);
})();
