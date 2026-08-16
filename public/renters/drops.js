/* drops.js — rented drops archive.
 * Ported from public/renters.html lines 434-459 (`loadRentedDrops`).
 *
 * Owns: #dropTotal, #rentDrops, and the OPTIONS of #dropFilter. Also
 * repopulates the ACCOUNTS section's #accFilter as a side effect, exactly as the
 * original did: both selects list renters and /renter-drops is the only fetch
 * that returns them. It does not listen on either select — boot.js wires
 * #dropFilter's change, #loadDropsBtn and #refreshDrops.
 *
 * Registers only. boot.js drives the first paint (this section stays behind its
 * "Load drops archive" button, and boot.js is what hides that placeholder), and
 * per the lazy-section rule RT.reload.drops is not published until a load has
 * actually succeeded.
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("drops.js: RT (core.js) not loaded"); return; }

  // Wrapped rather than destructured so we don't care how core.js binds them.
  const $ = (id) => RT.$(id),
    esc = (s) => RT.esc(s);

  const ALL_OPT = '<option value="all">All renters</option>';

  // Read live, and tolerate a missing element the same way the original did
  // (`sel ? sel.value : "all"`), so a filter read can never throw synchronously
  // out of load(). An empty value normalises to "all", which is also how the
  // original's `chosen && chosen !== "all"` treated it.
  const filterVal = () => {
    const el = $("dropFilter");
    return (el && el.value) || "all";
  };

  // Swap a renter <select>'s options without losing the operator's choice.
  // `keep` is read by the caller BEFORE innerHTML is replaced.
  function fillRenterSelect(el, optsHtml, keep) {
    el.innerHTML = optsHtml;
    el.value = [...el.options].some((o) => o.value === keep) ? keep : "all";
  }

  function syncFilters(renters, chosen) {
    const sel = $("dropFilter");
    if (sel) {
      const opts = [ALL_OPT].concat(
        renters.map(
          (r) =>
            '<option value="' + esc(r.id) + '">' + esc(r.username) + " (" + esc(r.drops) + ")</option>"
        )
      );
      fillRenterSelect(sel, opts.join(""), chosen);
    }
    // Original side effect: the accounts filter is fed from this same payload,
    // minus the drop counts. Its own selection is preserved independently.
    const asel = $("accFilter");
    if (asel) {
      const opts = [ALL_OPT].concat(
        renters.map((r) => '<option value="' + esc(r.id) + '">' + esc(r.username) + "</option>")
      );
      fillRenterSelect(asel, opts.join(""), asel.value);
    }
  }

  // `chosen` is the #dropFilter value captured by load(), NOT re-read here: the
  // request and the select repopulation that follows it must agree on one renter
  // even if the operator moves the dropdown mid-flight.
  async function fetchAndRender(chosen) {
    const d = await RT.api(
      "/renter-drops" + (chosen && chosen !== "all" ? "?renter=" + encodeURIComponent(chosen) : "")
    );

    syncFilters(d.renters || [], chosen);

    $("dropTotal").textContent = d.total ? "· " + d.total + " drop" + (d.total === 1 ? "" : "s") : "";

    const items = d.items || [];
    const box = $("rentDrops");
    if (!items.length) {
      box.innerHTML =
        '<div class="muted" style="padding:6px 2px">No drops farmed by rented bots yet.</div>';
      return;
    }
    box.innerHTML =
      '<div class="dgrid">' +
      items
        .map((x) => {
          const img = x.image
            ? '<img src="' + esc(x.image) + '" alt="" referrerpolicy="no-referrer"/>'
            : '<span class="ph">' + esc((x.name || "?").slice(0, 2)) + "</span>";
          return (
            '<div class="drop">' +
            img +
            '<div class="nm"><b>' +
            esc(x.name) +
            "</b><span>" +
            esc(x.game || "") +
            '</span></div><span class="ct">×' +
            esc(x.count) +
            "</span></div>"
          );
        })
        .join("") +
      "</div>";
  }

  async function run(chosen) {
    try {
      await fetchAndRender(chosen);
      // Lazy-section rule: a global Refresh may only re-fetch drops once the
      // operator has actually opened the section and it loaded cleanly.
      RT.reload.drops = load;
    } catch (e) {
      const box = $("rentDrops");
      if (box) box.innerHTML = '<div class="muted">' + esc(e.message) + "</div>";
    }
  }

  let inflight = null; // newest in-flight load
  let inflightSel = null; // the #dropFilter value `inflight` is fetching for

  // Coalescing is keyed on the filter value: the Load button, the section
  // Refresh and a filter change can all fire in one tick for the SAME renter and
  // one request is enough. A #dropFilter change mid-flight must not get the
  // in-flight promise for the OLD renter back, though — nothing would be fetched
  // for the newly picked one, and that stale render would then snap the select
  // back to "All renters" while repopulating it. A different value chains a
  // fresh load onto the current one, so the newest filter renders last and wins,
  // as in the original.
  function load() {
    const sel = filterVal();
    if (inflight && inflightSel === sel) return inflight;
    const p = inflight ? inflight.catch(() => {}).then(() => run(sel)) : run(sel);
    inflight = p;
    inflightSel = sel;
    p.catch(() => {}).then(() => {
      // Only the newest load clears the slot; an older link in the chain
      // finishing must not unlock a still-running successor.
      if (inflight === p) {
        inflight = null;
        inflightSel = null;
      }
    });
    return p;
  }

  // No listener on #loadDropsBtn / #refreshDrops / #dropFilter and no action
  // registered for them: boot.js is the sole wirer of all three (a listener here
  // too would mean two fetches per click), and it also owns hiding #dropsIdle.
  // Nothing in the markup carries data-act for this section.
  RT.drops = {
    load, // first open / section refresh — the only way in before RT.reload.drops exists
    reload: () => (RT.reload.drops ? load() : Promise.resolve()), // no-op if never loaded
  };
})();
