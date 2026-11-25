// Navigation presentation only. Companion data and controls remain behind the
// authenticated controller gateway and its existing CSRF checks.
(function () {
  try {
    document.documentElement.setAttribute("data-theme", localStorage.getItem("theme") === "dark" ? "dark" : "light");
  } catch (_error) {
    document.documentElement.setAttribute("data-theme", "dark");
  }

  function bind() {
    var button = document.getElementById("controller-logout");
    if (!button) return;
    button.addEventListener("click", async function () {
      button.disabled = true;
      try {
        var response = await fetch("/admin-logout", { method: "POST", credentials: "same-origin" });
        if (!response.ok) throw new Error("Logout failed.");
        window.location.assign("/admin-login.html");
      } catch (_error) {
        button.disabled = false;
        button.setAttribute("aria-label", "Log out failed. Try again.");
        button.title = "Log out failed. Try again.";
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
