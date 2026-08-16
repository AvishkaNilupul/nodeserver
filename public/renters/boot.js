/* renters/boot.js — page chrome + first paint (original renters.html 817-867).
 *
 * Loaded LAST, so every module has already registered its actions and its
 * RT.reload entry by the time anything here runs.
 *
 * boot.js is the SOLE wirer of the two lazy sections: #loadAccsBtn,
 * #loadDropsBtn, #refreshAccs, #refreshDrops, #accFilter, #dropFilter. Neither
 * accounts.js nor drops.js touches those elements (a second listener would mean
 * two fetches per click). accounts.js still owns #accReveal, because it owns the
 * reveal-secrets flag that button toggles.
 *
 * Two different paths on purpose:
 *
 *   - Opening a lazy section calls the module's loader DIRECTLY
 *     (RT.accounts.load / RT.drops.load). It cannot go through RT.reloadMany:
 *     the key only lands in RT.reload after a first successful load, and
 *     reloadMany silently skips absent keys — so the registry route made the
 *     very first click a no-op, which is the bug this wiring fixes.
 *   - The global Refresh reloads the three always-on sections through
 *     RT.reloadMany, then calls the lazy loaders directly for whichever
 *     sections have been OPENED — tracked here as accsOpened / dropsOpened,
 *     the original's ACCS_LOADED / DROPS_LOADED. A section the operator never
 *     opened is still not force-fetched.
 *
 * Openedness is deliberately NOT read off RT.reload. Those keys land only on a
 * SUCCESSFUL load, so a section whose first load failed would look unopened
 * forever: its filter would go dead and the global Refresh would step over it,
 * leaving stale error text sitting under a page that otherwise visibly
 * refreshed, recoverable only from the section's own Refresh. The original set
 * the flag at click time, pass or fail (817-846); so does this.
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("renters/boot.js: core.js must load first"); return; }
  const $ = RT.$;

  // ---- helpers ------------------------------------------------------------

  function bind(id, ev, fn) {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
    return el;
  }

  // One always-loaded section, through the registry.
  function reload(key) { return RT.reloadMany([key]); }

  // The two lazy sections, straight to the owning module. Guarded on the module
  // surface so one module that failed to parse can't take the page's wiring with
  // it. Each loader coalesces overlapping calls itself.
  function loadAccounts() {
    return RT.accounts && RT.accounts.load ? RT.accounts.load() : Promise.resolve();
  }
  function loadDrops() {
    return RT.drops && RT.drops.load ? RT.drops.load() : Promise.resolve();
  }

  // Original revealLazy(): retire the "Load …" placeholder of a lazy section.
  // (It only ever hides — nothing in the page brings the placeholder back.)
  // boot.js is the only owner of these two placeholders.
  function retireIdle(idleId) {
    const el = $(idleId);
    if (el) el.style.display = "none";
  }

  // ---- lazy sections ------------------------------------------------------

  // Has the operator opened this section in this page view? (Original 821's
  // ACCS_LOADED / DROPS_LOADED.) Set on the click that opens the section,
  // whether or not the load that follows succeeds — see the header note.
  let accsOpened = false, dropsOpened = false;

  // The Load button sits INSIDE the placeholder it retires, so it is a
  // one-shot; from there the section's own Refresh drives it.
  bind("loadAccsBtn", "click", () => { retireIdle("accsIdle"); accsOpened = true; return loadAccounts(); });
  bind("loadDropsBtn", "click", () => { retireIdle("dropsIdle"); dropsOpened = true; return loadDrops(); });

  // ---- refresh wiring -----------------------------------------------------

  // Global Refresh: the three always-loaded sections plus the two lazy ones,
  // which are skipped unless they have been opened.
  //
  // Deliberately NOT one reloadMany(["…","drops","accounts"]) call. RT.reload
  // gains those two keys only on a SUCCESSFUL load and reloadMany drops absent
  // keys, so a section whose first load failed would be stepped over here —
  // leaving its error text sitting under a page that just visibly refreshed
  // everything else. Gate on the local flags instead and call the loaders
  // directly. All of it goes in flight at once, as before.
  bind("refreshBtn", "click", () => {
    const jobs = [RT.reloadMany(["approvals", "renters", "bots"])];
    if (accsOpened) jobs.push(loadAccounts());
    if (dropsOpened) jobs.push(loadDrops());
    return Promise.all(jobs);
  });
  bind("refreshBots", "click", () => reload("bots"));
  // A section Refresh doubles as a first open (original 839-840 hid the
  // placeholder and set the LOADED flag before fetching, whether or not the
  // section had ever been loaded), so it retires the placeholder, marks the
  // section opened and calls the loader directly — same path as the Load button.
  bind("refreshDrops", "click", () => { retireIdle("dropsIdle"); dropsOpened = true; return loadDrops(); });
  bind("refreshAccs", "click", () => { retireIdle("accsIdle"); accsOpened = true; return loadAccounts(); });

  // ---- filter changes -----------------------------------------------------

  // Original 841/847: a filter change re-fetches only a section that is already
  // open — it must not be the thing that first opens one (the section's
  // placeholder would still be sitting above freshly rendered rows). The gate is
  // accsOpened / dropsOpened, the original's ACCS_LOADED / DROPS_LOADED, NOT the
  // presence of RT.reload.<key>: that key appears only after a load succeeded,
  // so with it as the gate a section whose first load failed would have a dead
  // filter and no way back except its own Refresh. Once past the gate the fetch
  // goes straight to the module loader.
  //
  // Reachable before either section is open: #accFilter and #dropFilter are
  // populated as a side effect of the drops load, so loading drops alone makes
  // the accounts filter selectable.
  bind("accFilter", "change", () => (accsOpened ? loadAccounts() : Promise.resolve()));
  bind("dropFilter", "change", () => (dropsOpened ? loadDrops() : Promise.resolve()));

  // ---- logout -------------------------------------------------------------

  bind("logoutBtn", "click", async () => {
    try { await fetch("/admin-logout", { method: "POST", credentials: "same-origin" }); } catch (e) {}
    location.href = "/admin-login.html";
  });

  // ---- first paint --------------------------------------------------------

  (async function init() {
    // Header identity is independent of the page data — fill it in whenever
    // it lands instead of blocking the first data paint on it.
    RT.api("/shop/me").then(me => {
      $("meName").textContent = me.username || "Admin";
      $("meAvatar").textContent = (me.username || "A").slice(0, 2).toUpperCase();
    }).catch(() => {});
    // Only what managing renters actually needs. The accounts and drops
    // sections are thousands of rows between them and used far less often,
    // so they stay behind their Load buttons instead of blocking this page
    // every time it opens.
    //
    // Hosts must load before the bot picker (it builds the host options),
    // but the rest are independent. These used to await one after another,
    // so "Rented bots" (last in line) only started after the other four
    // finished — the page paid the SUM of all five round-trips. Fetch the
    // independent ones concurrently so it costs the slowest call, not their
    // total.
    await reload("hosts");
    await RT.reloadMany(["botPicker", "approvals", "renters", "bots"]);
  })();
})();
