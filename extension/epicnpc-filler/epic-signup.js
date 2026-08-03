// Drives the epicgames.com/id/register wizard for extension-created
// accounts, and scrapes the authorizationCode from /id/api/redirect on
// finalisation. The service worker (background.js) supplies the identity
// and shepherds the OTP fetch + code exchange.
(function () {
  "use strict";

  function sessionIdFromHash() {
    var m = (location.hash || "").match(/epicgen=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  var sessionId = sessionIdFromHash();
  if (!sessionId) return; // not our tab

  function sw(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          resolve(resp || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message });
      }
    });
  }

  function banner(text, kind) {
    var el = document.getElementById("epicgen-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "epicgen-banner";
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
        "padding:12px 18px;font:600 14px system-ui,sans-serif;color:#fff;" +
        "text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.35);";
      document.documentElement.appendChild(el);
    }
    el.style.background =
      kind === "err" ? "#c0392b" : kind === "ok" ? "#1f9d55" : "#1e6bd3";
    el.textContent = text;
  }

  function setVal(el, val) {
    if (!el) return;
    var pr =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(pr, "value").set.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function jitter(min, max) {
    return min + Math.floor(Math.random() * (max - min));
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function waitFor(pred, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 30000);
    return new Promise(function (resolve, reject) {
      (function step() {
        var out;
        try {
          out = pred();
        } catch (e) {
          out = null;
        }
        if (out) return resolve(out);
        if (Date.now() > deadline) return reject(new Error("timeout"));
        setTimeout(step, 200);
      })();
    });
  }

  function findByLabel(labelRe) {
    var labels = document.querySelectorAll("label");
    for (var i = 0; i < labels.length; i++) {
      if (labelRe.test(labels[i].textContent || "")) {
        var forId = labels[i].getAttribute("for");
        if (forId) {
          var el = document.getElementById(forId);
          if (el) return el;
        }
        var inner = labels[i].querySelector("input,select,textarea");
        if (inner) return inner;
      }
    }
    return null;
  }

  async function typeSlowly(el, val) {
    setVal(el, "");
    var s = String(val);
    for (var i = 0; i < s.length; i++) {
      var next = el.value + s.charAt(i);
      setVal(el, next);
      await sleep(jitter(35, 90));
    }
  }

  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Find the trigger for a custom React dropdown labelled "Month"/"Day"/"Year".
  // Falls back through: aria-label, name attr, then buttons whose text/
  // placeholder starts with the field name.
  function findDropdownTrigger(labelWord) {
    var re = new RegExp("^\\s*" + labelWord + "\\b", "i");
    // Direct aria-label / placeholder / name matches on any element.
    var el = document.querySelector(
      '[aria-label*="' + labelWord + '" i], [placeholder*="' + labelWord +
        '" i], [name*="' + labelWord + '" i]',
    );
    if (el) return el.closest("button, [role=button], [role=combobox]") || el;
    // Buttons / combobox roles whose visible text starts with the label word.
    var candidates = document.querySelectorAll(
      'button, [role="button"], [role="combobox"], [aria-haspopup="listbox"]',
    );
    for (var i = 0; i < candidates.length; i++) {
      var t = (candidates[i].textContent || "").trim();
      if (re.test(t)) return candidates[i];
    }
    return null;
  }

  async function pickDropdownOption(trigger, valueText) {
    if (!trigger) return false;
    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    trigger.click();
    // Wait for the listbox to render.
    var listbox = null;
    try {
      listbox = await waitFor(function () {
        return document.querySelector(
          '[role="listbox"]:not([hidden]), ul[role="menu"]:not([hidden]), [role="option"]',
        );
      }, 3000);
    } catch (e) {
      listbox = null;
    }
    var options = document.querySelectorAll(
      '[role="option"], li[role="menuitem"], li[data-value], [role="menuitemradio"]',
    );
    var wanted = String(valueText).trim().toLowerCase();
    for (var i = 0; i < options.length; i++) {
      var text = String(options[i].textContent || "").trim().toLowerCase();
      var dv = String(options[i].getAttribute("data-value") || "")
        .trim()
        .toLowerCase();
      if (text === wanted || dv === wanted || text.startsWith(wanted + " ")) {
        options[i].scrollIntoView({ block: "center", behavior: "instant" });
        options[i].click();
        return true;
      }
    }
    // Fallback: numeric prefix match (e.g. "2" vs "02").
    for (var j = 0; j < options.length; j++) {
      var t2 = String(options[j].textContent || "").trim();
      if (t2 && parseInt(t2, 10) === parseInt(wanted, 10)) {
        options[j].scrollIntoView({ block: "center", behavior: "instant" });
        options[j].click();
        return true;
      }
    }
    return false;
  }

  async function fillDob(iso) {
    var parts = iso.split("-"); // YYYY-MM-DD
    var y = parts[0];
    var m = parseInt(parts[1], 10); // 1-12
    var d = parseInt(parts[2], 10);
    var monthName = MONTHS[m - 1];

    // Native <input type="date"> path (older/other flow variants).
    var native = document.querySelector(
      'input[type="date"], input[name="dateOfBirth"]',
    );
    if (native) {
      setVal(native, iso);
      return true;
    }
    // Native three-select path.
    var monthSelNative = document.querySelector('select[name*="month" i]');
    if (monthSelNative) {
      setVal(monthSelNative, String(m));
      var daySelNative = document.querySelector('select[name*="day" i]');
      var yearSelNative = document.querySelector('select[name*="year" i]');
      if (daySelNative) setVal(daySelNative, String(d));
      if (yearSelNative) setVal(yearSelNative, y);
      return true;
    }

    // Current Epic pattern (2026): MUI Autocomplete for Month with
    // id="month" role="combobox", plain tel inputs for id="day"/id="year".
    var monthInput = document.getElementById("month");
    var dayInput = document.getElementById("day");
    var yearInput = document.getElementById("year");
    if (!monthInput || !dayInput || !yearInput) {
      console.warn(
        "epicgen DOB: missing inputs — month=" +
          !!monthInput +
          " day=" +
          !!dayInput +
          " year=" +
          !!yearInput,
      );
      return false;
    }

    // Month: focus, type the name, wait for the filtered option, click it.
    monthInput.focus();
    setVal(monthInput, "");
    await sleep(80);
    // Type char-by-char so MUI's onChange filter engages.
    for (var i = 0; i < monthName.length; i++) {
      setVal(monthInput, monthName.slice(0, i + 1));
      monthInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: monthName[i], bubbles: true }),
      );
      await sleep(30);
    }
    // Give MUI a beat to render the listbox.
    await sleep(400);
    // Prefer clicking the visible option that matches; fall back to
    // ArrowDown+Enter.
    var picked = false;
    var opts = document.querySelectorAll('li[role="option"], [role="option"]');
    for (var oi = 0; oi < opts.length; oi++) {
      var t = String(opts[oi].textContent || "").trim().toLowerCase();
      if (t === monthName.toLowerCase()) {
        opts[oi].click();
        picked = true;
        break;
      }
    }
    if (!picked && opts.length) {
      opts[0].click();
      picked = true;
    }
    if (!picked) {
      // Last-ditch: keyboard fallback.
      monthInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      await sleep(80);
      monthInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    }
    await sleep(200);

    // Day + Year — simple text inputs; setVal already dispatches
    // input+change so MUI's controlled state updates.
    dayInput.focus();
    setVal(dayInput, String(d));
    dayInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(120);

    yearInput.focus();
    setVal(yearInput, String(y));
    yearInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(120);

    return true;
  }

  // -------- State-machine dispatcher --------
  // Epic's register flow is multi-step and each screen has distinct DOM.
  // We detect which step is on-screen and handle it, then wait for the DOM
  // to change and re-dispatch. This survives Epic reshaping individual
  // steps or splitting them further, as long as the DOM markers below hold.

  function stepId() {
    // OTP boxes: six single-char inputs, or one autocomplete=one-time input.
    var otpBoxes = document.querySelectorAll('input[maxlength="1"]');
    if (
      otpBoxes.length >= 6 ||
      document.querySelector('input[autocomplete*="one-time" i]')
    ) {
      return "otp";
    }
    // Details step: has a password field.
    if (
      document.querySelector('input[type="password"]') ||
      document.querySelector('input[name="password"]')
    ) {
      return "details";
    }
    // Email step: has email input but no password field, and no OTP.
    if (
      document.querySelector('input[type="email"]') ||
      document.querySelector('input[name="email"]')
    ) {
      return "email";
    }
    // DOB step: has our known month/day/year triad.
    if (
      document.getElementById("month") ||
      document.querySelector('input[type="date"]') ||
      document.querySelector('select[name*="month" i]')
    ) {
      return "dob";
    }
    // Signed-in landing pages.
    if (/\/(account|personal)/i.test(location.pathname)) return "done";
    return null;
  }

  function clickContinueLike() {
    var b =
      document.getElementById("continue") ||
      Array.prototype.find.call(
        document.querySelectorAll("button"),
        function (btn) {
          return /continue|create.*account|sign up|register|verify|submit|next/i.test(
            btn.textContent || "",
          );
        },
      );
    if (b && !b.disabled) {
      b.click();
      return true;
    }
    return false;
  }

  async function waitForStepChange(fromStep, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      var s = stepId();
      if (s !== fromStep && s !== null) return s;
      // Bail early on phone-verification.
      var phone = document.querySelector(
        'input[type="tel"][name*="phone" i], input[name="phoneNumber"]',
      );
      if (phone && phone.offsetParent !== null) return "sms_required";
      await sleep(400);
    }
    return fromStep;
  }

  async function handleDobStep(id) {
    banner("Filling date of birth…", "info");
    var ok = await fillDob(id.dateOfBirth);
    if (!ok) throw new Error("DOB fill failed");
    await sleep(jitter(400, 800));
    clickContinueLike();
  }

  async function handleEmailStep(id) {
    banner("Filling email…", "info");
    var emailInput =
      document.querySelector('input[type="email"]') ||
      document.querySelector('input[name="email"]') ||
      document.getElementById("email");
    if (!emailInput) throw new Error("email input not found");
    await typeSlowly(emailInput, id.email);
    emailInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(jitter(400, 800));
    clickContinueLike();
  }

  async function handleDetailsStep(id) {
    banner("Filling account details…", "info");
    var emailInput =
      document.querySelector('input[type="email"]') ||
      document.querySelector('input[name="email"]') ||
      document.getElementById("email");
    var pwdInput =
      document.querySelector('input[type="password"]') ||
      document.querySelector('input[name="password"]') ||
      document.getElementById("password");
    var firstInput =
      document.querySelector('input[name*="first" i]') ||
      document.getElementById("firstName") ||
      findByLabel(/first name/i);
    var lastInput =
      document.querySelector('input[name*="last" i]') ||
      document.getElementById("lastName") ||
      findByLabel(/last name/i);
    // NOTE: don't overwrite display name — Epic auto-suggests a valid,
    // unique one. Overriding often trips its uniqueness check.

    // Re-type the email on this step too. Epic's details form is a new
    // React component; the field looks pre-populated (Epic paints the
    // string) but React's local state is empty until an input event fires,
    // which is why /id/api/account was returning invalid_email with an
    // empty invalidValue when we skipped this.
    if (emailInput) await typeSlowly(emailInput, id.email);
    if (firstInput) await typeSlowly(firstInput, id.firstName);
    if (lastInput) await typeSlowly(lastInput, id.lastName);
    if (pwdInput) await typeSlowly(pwdInput, id.password);

    // Tick ToS-style checkboxes; skip marketing opt-ins.
    var checks = document.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < checks.length; i++) {
      var box = checks[i];
      var lbl = "";
      var lf = box.closest("label");
      if (lf) lbl = lf.textContent || "";
      if (!lbl && box.id) {
        var lElem = document.querySelector('label[for="' + box.id + '"]');
        if (lElem) lbl = lElem.textContent || "";
      }
      // Also check the checkbox's siblings / parent-row for label-like text
      // (Epic often uses spans next to the input rather than <label for>).
      if (!lbl && box.parentElement) {
        lbl = box.parentElement.textContent || "";
      }
      if (/agree|accept|terms|privacy/i.test(lbl) && !box.checked) box.click();
    }

    await sleep(jitter(500, 900));
    await sw({
      type: "epicgen-status",
      sessionId: sessionId,
      status: "awaiting_captcha",
    });
    banner(
      "Form filled ✓ — click the captcha (if shown), then click Continue yourself.",
      "info",
    );
    // Don't auto-click Continue. hCaptcha tokens rotate every ~2 min and
    // auto-clicking too fast tends to submit against a token Talon has
    // already invalidated. Let LO click; that also gives hCaptcha's
    // behavioral telemetry a real interaction to attest to.
    //
    // We just wait for the step to change (main loop handles that), while
    // watching for the sms_required detour or a visible form error.
    var deadline = Date.now() + 5 * 60 * 1000;
    var lastErrText = "";
    while (Date.now() < deadline) {
      var s = stepId();
      if (s === "otp" || s === "done") return;
      var phone = document.querySelector(
        'input[type="tel"][name*="phone" i], input[name="phoneNumber"]',
      );
      if (phone && phone.offsetParent !== null) {
        throw new Error("phone verification requested");
      }
      // Surface any inline form error Epic renders (MUI FormHelperText,
      // role=alert, or MUI error classes).
      var errNodes = document.querySelectorAll(
        '[role="alert"], .MuiFormHelperText-root.Mui-error, .MuiAlert-message, .Mui-error',
      );
      var errText = "";
      for (var ei = 0; ei < errNodes.length; ei++) {
        var t = String(errNodes[ei].textContent || "").trim();
        if (t) {
          errText += (errText ? " · " : "") + t;
        }
      }
      if (errText && errText !== lastErrText) {
        console.warn("epicgen form error:", errText);
        banner("Epic error: " + errText, "err");
        lastErrText = errText;
      }
      await sleep(600);
    }
    throw new Error("captcha timeout");
  }

  async function handleOtpStep() {
    await sw({
      type: "epicgen-status",
      sessionId: sessionId,
      status: "awaiting_otp",
    });
    banner("Waiting for OTP from mail.tm…", "info");
    var resp = await sw({
      type: "epicgen-request-otp",
      sessionId: sessionId,
    });
    if (!resp.ok) throw new Error("otp: " + (resp.error || "unknown"));
    var code = String(resp.code || "");
    banner("OTP received — entering " + code, "info");

    var boxes = document.querySelectorAll('input[maxlength="1"]');
    if (boxes.length >= 6) {
      for (var i2 = 0; i2 < 6; i2++) {
        boxes[i2].focus();
        setVal(boxes[i2], code.charAt(i2));
        boxes[i2].dispatchEvent(
          new KeyboardEvent("keydown", {
            key: code.charAt(i2),
            bubbles: true,
          }),
        );
        await sleep(jitter(60, 110));
      }
    } else {
      var one =
        document.querySelector('input[autocomplete*="one-time" i]') ||
        document.querySelector('input[name*="code" i]');
      if (one) await typeSlowly(one, code);
    }
    await sleep(jitter(600, 1200));
    clickContinueLike();
  }

  async function handleDone() {
    banner("Signed in — capturing authorization code…", "ok");
    await sleep(1500);
    await sw({ type: "epicgen-open-redirect", sessionId: sessionId });
    banner(
      "Signup complete — token capture running in background. You can close this tab.",
      "ok",
    );
  }

  async function driveRegisterFlow(session) {
    var id = session.identity;
    banner("Epic signup for " + id.email + " — starting…", "info");
    var lastStep = null;
    var startTs = Date.now();
    var maxMs = 10 * 60 * 1000;
    while (Date.now() - startTs < maxMs) {
      var step = stepId();
      if (step === lastStep || step === null) {
        await sleep(500);
        continue;
      }
      console.log("epicgen step ->", step);
      try {
        if (step === "sms_required") {
          banner(
            "Epic asked for phone verification — aborting. Try again from a different IP later.",
            "err",
          );
          await sw({
            type: "epicgen-status",
            sessionId: sessionId,
            status: "sms_required",
            extra: { lastError: "phone verification requested" },
          });
          return;
        }
        if (step === "dob") await handleDobStep(id);
        else if (step === "email") await handleEmailStep(id);
        else if (step === "details") await handleDetailsStep(id);
        else if (step === "otp") await handleOtpStep();
        else if (step === "done") {
          await handleDone();
          return;
        }
      } catch (err) {
        banner("Step " + step + " failed: " + err.message, "err");
        await sw({
          type: "epicgen-abort",
          sessionId: sessionId,
          reason: step + ": " + err.message,
        });
        return;
      }
      lastStep = step;
      // Wait for the DOM to actually advance before the next dispatch.
      var next = await waitForStepChange(step, 60000);
      if (next === step) {
        // 60s and nothing changed → likely form-validation error we can't see.
        banner(
          "Stuck on " + step + " — check the form for a red error banner.",
          "err",
        );
        await sw({
          type: "epicgen-abort",
          sessionId: sessionId,
          reason: step + " stalled",
        });
        return;
      }
    }
    banner("Timed out after " + Math.round(maxMs / 60000) + " min.", "err");
    await sw({
      type: "epicgen-abort",
      sessionId: sessionId,
      reason: "flow timeout",
    });
  }

  async function scrapeAuthCode(session) {
    // /id/api/redirect returns raw JSON. document.body.textContent has it.
    var raw = document.body ? document.body.textContent || "" : "";
    var m = raw.match(/[0-9a-f]{32}/i);
    if (!m) {
      // Sometimes the page hasn't rendered yet.
      await waitFor(function () {
        return (
          document.body && (document.body.textContent || "").match(/[0-9a-f]{32}/i)
        );
      }, 8000);
      raw = document.body.textContent || "";
      m = raw.match(/[0-9a-f]{32}/i);
    }
    if (!m) {
      banner("Could not find authorization code on redirect page.", "err");
      await sw({
        type: "epicgen-abort",
        sessionId: sessionId,
        reason: "authcode scrape failed",
      });
      return;
    }
    var code = m[0].toLowerCase();
    var resp = await sw({
      type: "epicgen-authcode",
      sessionId: sessionId,
      code: code,
    });
    if (resp.ok) {
      banner("Account saved to nodeserver ✓", "ok");
    } else {
      banner("Save failed: " + (resp.error || "unknown"), "err");
    }
  }

  (async function () {
    var s = await sw({ type: "epicgen-session-request", sessionId: sessionId });
    if (!s.ok || !s.session) return;
    var path = location.pathname || "";
    try {
      if (/\/id\/api\/redirect/i.test(path)) {
        await scrapeAuthCode(s.session);
      } else {
        await driveRegisterFlow(s.session);
      }
    } catch (err) {
      banner("Signup error: " + (err && err.message), "err");
      await sw({
        type: "epicgen-abort",
        sessionId: sessionId,
        reason: err && err.message,
      });
    }
  })();
})();
