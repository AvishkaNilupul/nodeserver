// EpicNPC Filler - content script.
// Same fill logic as the panel's bookmarklet (field names/flow verified live
// on real XenForo compose forms), but it runs automatically as soon as a
// compose page opened from the panel's "Sell on EpicNPC" button loads.
// It NEVER submits: it fills, highlights "Post thread", and shows a banner.
(function () {
  "use strict";

  function getPayload() {
    var m = (location.hash || "").match(/epfill=([^&]+)/);
    if (!m) return null;
    try {
      var b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) {
      return null;
    }
  }

  function setVal(el, val) {
    var pr =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(pr, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tierFor(price, t) {
    if (t && /service|boost/i.test(t)) return "Service";
    var n = Number(price) || 0;
    return n >= 50 ? "HighEnd" : n >= 15 ? "Average" : "LowEnd";
  }

  function banner(text, ok) {
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
      "z-index:99999;padding:10px 18px;border-radius:8px;font:600 14px " +
      "system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
      "background:" +
      (ok ? "#1f9d55" : "#c0392b");
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .6s";
      el.style.opacity = "0";
      setTimeout(function () {
        el.remove();
      }, 700);
    }, 6000);
  }

  function fill(p) {
    var title = document.querySelector(
      'textarea[name="title"],input[name="title"]',
    );
    if (title) setVal(title, p.title || "");

    // Tag the thread "Selling" on forums that offer that prefix.
    var pfx = document.querySelector('select[name="prefix_id"]');
    if (pfx)
      for (var pi = 0; pi < pfx.options.length; pi++)
        if (/^\s*selling\s*$/i.test(pfx.options[pi].text)) {
          pfx.value = pfx.options[pi].value;
          pfx.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }

    // Prefer the server-built rich HTML body (house style); fall back to
    // plain text with paragraph breaks. descHtml is our own trusted markup
    // (dynamic bits are escaped server-side).
    var html = p.descHtml
      ? p.descHtml
      : "<p>" +
        String(p.description || "")
          .replace(/</g, "&lt;")
          .replace(/\n/g, "</p><p>") +
        "</p>";
    var fr = document.querySelector('.fr-element[contenteditable="true"]');
    var hid = document.querySelector('textarea[name="message_html"]');
    if (fr) {
      fr.innerHTML = html;
      fr.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (hid) setVal(hid, html);

    var want = tierFor(p.priceUsd, p.tier);
    var sels = document.querySelectorAll("select"),
      typeSel = null;
    for (var i = 0; i < sels.length && !typeSel; i++)
      for (var j = 0; j < sels[i].options.length; j++)
        if (/High End|Low End/i.test(sels[i].options[j].text)) {
          typeSel = sels[i];
          break;
        }
    if (typeSel)
      for (var k = 0; k < typeSel.options.length; k++) {
        var o = typeSel.options[k];
        if (
          o.value === want ||
          o.text.replace(/\s/g, "").toLowerCase().indexOf(want.toLowerCase()) >=
            0
        ) {
          typeSel.value = o.value;
          typeSel.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }

    var yes = document.querySelector(
      'input[name="custom_fields[Original_Owner]"][value="Yes"]',
    );
    if (yes) {
      yes.checked = true;
      yes.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var tg = document.querySelector('input[name="tg_enabled"]');
    if (tg && !tg.checked) tg.click();

    var tries = 0;
    (function afterTG() {
      var price = document.querySelector('#tg_price,input[name="tg_price"]');
      var svc = null,
        boxes = document.querySelectorAll('input[name="tg_services[]"]');
      for (var i = 0; i < boxes.length; i++)
        if (boxes[i].value === (p.service || "free")) svc = boxes[i];
      if (price && p.priceUsd != null && price.value !== String(p.priceUsd))
        setVal(price, String(p.priceUsd));
      if (svc && !svc.checked) svc.click();
      // Keep retrying until values stick - Trade Guardian fields render (and
      // re-render) a beat after the toggle, so one set can silently no-op.
      var priceOk =
        !!price && (p.priceUsd == null || price.value === String(p.priceUsd));
      var svcOk = !!svc && svc.checked;
      if ((!priceOk || !svcOk) && tries++ < 40) {
        setTimeout(afterTG, 120);
        return;
      }
      var tags = document.querySelector('input[name="tags"]');
      if (tags && p.tags) setVal(tags, p.tags);
      var btns = document.querySelectorAll("button"),
        sb = null;
      for (var b2 = 0; b2 < btns.length && !sb; b2++)
        if (/post thread/i.test(btns[b2].innerText || "")) sb = btns[b2];
      if (sb) {
        sb.style.outline = "3px solid #35c37d";
        sb.scrollIntoView({ block: "center" });
      }
      banner(
        "EpicNPC Filler: form filled - review and click Post thread",
        true,
      );
    })();
  }

  // Only act on compose pages opened from the panel (payload in the hash).
  var payload = getPayload();
  if (!payload) return;

  // Wait for the compose form to actually exist - XenForo finishes rendering
  // (rich text editor included) after document_idle on slow connections.
  var waited = 0;
  (function waitForForm() {
    var ready =
      document.querySelector('textarea[name="title"],input[name="title"]') &&
      (document.querySelector('.fr-element[contenteditable="true"]') ||
        document.querySelector('textarea[name="message_html"]'));
    if (ready) {
      try {
        fill(payload);
      } catch (e) {
        banner("EpicNPC Filler error: " + e.message, false);
      }
      return;
    }
    if ((waited += 200) < 20000) setTimeout(waitForForm, 200);
  })();
})();
