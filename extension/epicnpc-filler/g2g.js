// G2G auto-attach - content script for g2g.com.
// G2G's Open API refuses to create item-category offers (non-instant
// delivery), and the create-offer form is a dynamic Vue app that's fragile to
// fill field-by-field. But G2G's Bulk Upload accepts the .xlsx the panel
// already builds. So the panel opens g2g.com with the file in the URL hash
// (#g2gfill=<base64url xlsx>&fn=<name>) and this script attaches it to the
// upload input the moment one appears. It NEVER submits - the seller reviews
// the parsed offers and clicks G2G's own upload/confirm button.
(function () {
  "use strict";

  var payload = null; // { file: File, name: string }
  var attached = false;
  var bannerEl = null;

  function parseHash() {
    var m = (location.hash || "").match(/g2gfill=([^&]+)(?:&fn=([^&]+))?/);
    if (!m) return null;
    try {
      var b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      var bin = atob(b);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var name = m[2] ? decodeURIComponent(m[2]) : "g2g-bulk.xlsx";
      var file = new File([bytes], name, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      return { file: file, name: name };
    } catch (e) {
      return null;
    }
  }

  function banner(text, ok, withDownload) {
    if (bannerEl) bannerEl.remove();
    var el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
      "z-index:2147483647;padding:10px 18px;border-radius:8px;" +
      "font:600 14px system-ui,sans-serif;color:#fff;display:flex;" +
      "align-items:center;gap:12px;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
      "background:" +
      (ok ? "#1f9d55" : "#b7791f");
    var span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    if (withDownload && payload) {
      var a = document.createElement("a");
      a.textContent = "Download file";
      a.href = URL.createObjectURL(payload.file);
      a.download = payload.name;
      a.style.cssText =
        "color:#fff;text-decoration:underline;font:600 13px system-ui,sans-serif";
      el.appendChild(a);
    }
    var x = document.createElement("button");
    x.textContent = "×";
    x.setAttribute("aria-label", "Dismiss");
    x.style.cssText =
      "background:none;border:0;color:#fff;font-size:16px;cursor:pointer;padding:0 2px";
    x.onclick = function () {
      el.remove();
    };
    el.appendChild(x);
    document.body.appendChild(el);
    bannerEl = el;
  }

  function fileInputs() {
    // Any file input that accepts spreadsheets (or declares no accept at
    // all - G2G's bulk uploader has used both over time).
    return Array.prototype.filter.call(
      document.querySelectorAll('input[type="file"]'),
      function (inp) {
        var acc = (inp.getAttribute("accept") || "").toLowerCase();
        return !acc || /xls|excel|spreadsheet|csv/.test(acc);
      },
    );
  }

  function tryAttach() {
    if (attached || !payload) return;
    var inputs = fileInputs();
    if (!inputs.length) return;
    var inp = inputs[0];
    try {
      var dt = new DataTransfer();
      dt.items.add(payload.file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      attached = true;
      banner(
        "G2G Filler: " +
          payload.name +
          " attached - review the offers, then confirm the upload",
        true,
        false,
      );
    } catch (e) {
      banner("G2G Filler: auto-attach failed - " + e.message, false, true);
    }
  }

  payload = parseHash();
  if (!payload) return;

  // Drop the huge hash so reloads/bookmarks stay clean; the file lives in
  // memory for this tab from here on.
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {
    /* non-fatal */
  }

  banner(
    "G2G Filler: bulk file ready (" +
      payload.name +
      ") - open Create Offer \u2192 Bulk Upload and it will attach itself",
    false,
    true,
  );

  // The upload input renders (and re-renders) as the seller navigates the
  // SPA - watch the DOM for it instead of polling a fixed selector.
  tryAttach();
  var mo = new MutationObserver(function () {
    tryAttach();
    if (attached) mo.disconnect();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
