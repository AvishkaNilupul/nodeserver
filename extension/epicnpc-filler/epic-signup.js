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
  var automation = {};
  var navigationChallengeMs = 0;
  // The worker binds sessions to tab IDs, surviving navigation without a hash.

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
        "text-align:center;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.35);";
      document.documentElement.appendChild(el);
    }
    el.style.background =
      kind === "err" ? "#c0392b" : kind === "ok" ? "#1f9d55" : "#1e6bd3";
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function showRetry(session) {
    var host=document.getElementById('epicgen-banner');
    if(!host||host.dataset.kind!=='err'||document.getElementById('epicgen-retry'))return;
    var button=document.createElement('button');
    button.id='epicgen-retry';button.textContent='Retry this signup';
    button.style.cssText='pointer-events:auto;margin-left:14px;padding:6px 12px;cursor:pointer';
    button.addEventListener('click',async function(){
      button.disabled=true;
      try {
        var resumed=await sw({type:'epicgen-resume-current',sessionId:sessionId});
        if(!resumed.ok)throw new Error(resumed.error||'Could not resume this signup');
        var step=stepId();
        // Request a new email explicitly before consuming a newer OTP.
        if(step==='otp')await waitFor(clickResendCode,60000);
        if(step==='details'||step==='login_password')location.reload();
        else {host.textContent='Resuming the same signup…';await driveRegisterFlow(session);showRetry(session);}
      } catch(err) {banner('Retry paused: '+err.message,'err');showRetry(session);}
    });
    host.appendChild(button);
  }

  function setVal(el, val) {
    if (!el) return;
    var pr =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
      el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
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
    if (/\/correction\/eula/i.test(location.pathname)) return "agreement";
    // Settings pages also contain email inputs; signed-in URLs take priority.
    if (/\/(account|personal)/i.test(location.pathname) || location.hostname === "store.epicgames.com") return "done";
    if (/\/review\/mfa-settings/i.test(location.pathname)) return "login_review_mfa";
    if (/\/review\/link-console/i.test(location.pathname)) return "login_review_console";
    var phone = document.querySelector('input[name="phoneNumber"], input[type="tel"][name*="phone" i]');
    if (phone && phone.offsetParent !== null) return "sms_required";
    // OTP boxes: six single-char inputs, or one autocomplete=one-time input.
    var otpBoxes = document.querySelectorAll('input[name^="code-input-"], input[maxlength="1"]');
    if (
      otpBoxes.length >= 6 ||
      document.querySelector('input[autocomplete*="one-time" i]')
    ) {
      return "otp";
    }
    // Epic login has two successive password-bearing screens: Continue,
    // then Sign in. Treat them separately so the dispatcher fills both.
    if (document.querySelector('input[type="password"]') &&
        Array.prototype.some.call(document.querySelectorAll('button'), function (b) {
          return /^sign in$/i.test((b.textContent || '').trim()) && b.offsetParent !== null;
        })) return "login_password";
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
    if (/\/(account|personal)/i.test(location.pathname) || location.hostname === "store.epicgames.com") return "done";
    return null;
  }

  function visibleEnabled(button) {
    return button && button.offsetParent !== null && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }
  function clickContinueLike() {
    var direct = document.getElementById('continue');
    var button = visibleEnabled(direct) ? direct : Array.prototype.find.call(document.querySelectorAll('button'), function(b) {
      return visibleEnabled(b) && /^(continue|create(?: an)? account|sign up|sign in|log in|register|verify|submit|next)$/i.test((b.textContent || '').trim());
    });
    if (!button) return false;
    button.click(); return true;
  }
  function prepareAgreement() {
    Array.prototype.forEach.call(document.querySelectorAll('main, [role="dialog"], [role="document"], section, div'), function(el) {
      if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 80) {
        var overflow = window.getComputedStyle(el).overflowY;
        if (/auto|scroll/.test(overflow)) {el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));}
      }
    });
  }
  function clickAgreementAccept() {
    prepareAgreement();
    var button=Array.prototype.find.call(document.querySelectorAll('button'),function(b){return visibleEnabled(b)&&/^(accept|i accept|i agree)$/i.test((b.textContent||'').trim());});
    if(!button)return false;button.click();return true;
  }

  function clickReviewContinue(step) {
    var pattern=step==='login_review_mfa'?/^confirm$/i:/^(continue|done linking)$/i;
    var button=Array.prototype.find.call(document.querySelectorAll('button'),function(b){
      return visibleEnabled(b)&&pattern.test((b.innerText||b.textContent||'').trim());
    });
    if(!button)return false;button.click();return true;
  }

  function captchaVisible() {
    return Array.prototype.some.call(document.querySelectorAll('iframe[src*="hcaptcha"][src*="frame=challenge"], iframe[title*="challenge" i]'), function(frame) {
      var box = frame.getBoundingClientRect();
      var style = window.getComputedStyle(frame);
      return box.width > 80 && box.height > 80 && style.display !== 'none' &&
        style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    });
  }

  function registrationWaitState(state, challenge, now) {
    var elapsed = Math.max(0, now - state.lastPoll);
    state.lastPoll = now;
    if (challenge) {
      state.waitingMs += elapsed;
      state.challengeSeen = true;
      return { status: 'awaiting_captcha', timedOut: false };
    }
    if (state.challengeSeen) {
      // Give Epic a fresh response window after a human/companion completes
      // the challenge. A long challenge must not consume submission time.
      state.deadline = now + (state.responseMs || 120000);
      state.challengeSeen = false;
    }
    return { status: 'submitting', timedOut: now > state.deadline };
  }

  function renderedPageText() {
    var body=document.body;
    return body ? (typeof body.innerText==='string'?body.innerText:body.textContent||'') : '';
  }

  function serviceUnavailable() {
    // Storefronts include hidden error templates even on successful sign-in.
    // Only the authentication form's rendered message is a signup failure.
    if(!/\/id\/(?:login|register)(?:\/|$)/i.test(location.pathname || ''))return false;
    var text=renderedPageText();
    return /service is temporarily unavailable|too many requests|please try again later/i.test(text);
  }

  function continueAfterChallenge(state,visible) {
    if(typeof visible!=='boolean')visible=captchaVisible();
    if(visible){state.seen=true;state.clearedAt=0;return false;}
    if(!state.seen||state.clicks>=2||challengeRejected()||otpRejected()||serviceUnavailable())return false;
    if(!state.clearedAt){state.clearedAt=Date.now();return false;}
    if(Date.now()-state.clearedAt<3000)return false;
    // Closing/cancelling the dialog is not a completed security check.
    // Only resume when the SDK has delivered its normal form response.
    var completed=Array.prototype.some.call(document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]'),function(field){return Boolean(String(field.value||'').trim());});
    if(!completed)return false;
    if(!clickContinueLike())return false;
    state.seen=false;state.clicks++;return true;
  }

  function challengeRejected() {
    return /incorrect response[\s\S]{0,100}refresh the page/i.test(renderedPageText());
  }
  async function retryChallenge() {
    var result=await sw({type:'epicgen-retry-challenge',sessionId:sessionId});
    if(!result.ok)throw new Error(result.error||'CAPTCHA refresh limit reached');
    await sw({type:'epicgen-status',sessionId:sessionId,status:'awaiting_captcha'});
    banner('Epic rejected the challenge response. Refreshing it once more…','info');
    if(/\/id\/login/i.test(location.pathname))location.href='https://accounts.epicgames.com/auth/logout';
    else location.reload();
  }
  function clickResendCode() {
    var resend=Array.prototype.find.call(document.querySelectorAll('a, button'),function(el){return visibleEnabled(el)&&/^resend (?:email|code)$/i.test((el.innerText||el.textContent||'').trim());});
    if(!resend)return false;resend.click();return true;
  }

  function authContextRejected() {
    var text=renderedPageText();
    return (/\/id\/login\/mfa/i.test(location.pathname)&&/\bemail is invalid\b/i.test(text)) ||
      (/\/correction\/eula/i.test(location.pathname)&&/insufficient user authentication/i.test(text));
  }
  function refreshAgreementContext() {
    if(!/\/correction\/eula/i.test(location.pathname))return false;
    try {
      var key='epicgen.agreement-refresh.'+sessionId;
      if(sessionStorage.getItem(key)==='1')return false;
      sessionStorage.setItem(key,'1');
      location.reload();
      return true;
    } catch(e) { return false; }
  }

  async function resetAuthContext() {
    // Registration can reach Store review before its auth context settles.
    // Refresh that review once before requiring a full normal sign-in.
    if(refreshAgreementContext())return;
    var result=await sw({type:'epicgen-reset-auth-context',sessionId:sessionId});
    if(!result.ok)throw new Error(result.error||'Login context recovery unavailable');
    banner('Restarting the incomplete Epic sign-in session…','info');
    location.href='https://accounts.epicgames.com/auth/logout';
  }

  function otpRejected() {
    return /security code is invalid or expired|(?:verification|security) code (?:is )?(?:incorrect|invalid|expired)/i.test(renderedPageText());
  }

  async function waitForStepChange(fromStep, timeoutMs) {
    var responseMs = timeoutMs || 30000;
    var waitState={deadline:Date.now()+responseMs,lastPoll:Date.now(),responseMs:responseMs,waitingMs:0,challengeSeen:false};
    var challengeState={seen:false,clearedAt:0,clicks:0};
    var reportedChallenge=false;
    while (Date.now() < waitState.deadline) {
      if (serviceUnavailable()) throw new Error("Epic is temporarily unavailable. This signup is preserved; recover the same account later.");
      var s = stepId();
      if (s !== fromStep && s !== null) return s;
      if (challengeRejected()) return "challenge_rejected";
      if (authContextRejected()) return "auth_context_rejected";
      if (fromStep === "otp" && otpRejected()) return "otp_invalid";
      // Bail early on phone-verification.
      var phone = document.querySelector(
        'input[type="tel"][name*="phone" i], input[name="phoneNumber"]',
      );
      if (phone && phone.offsetParent !== null) return "sms_required";
      var challenge = captchaVisible();
      registrationWaitState(waitState,challenge,Date.now());
      if(sessionId && challenge !== reportedChallenge) {
        reportedChallenge=challenge;
        await sw({type:'epicgen-status',sessionId:sessionId,status:challenge?'awaiting_captcha':fromStep==='otp'?'awaiting_otp':'submitting'});
        banner(challenge?'Waiting for Epic’s security check. This signup is preserved.':'Security check closed. Waiting for Epic’s response…','info');
      }
      continueAfterChallenge(challengeState,challenge);
      var before = Date.now();
      await sleep(400);
      if (challenge) {
        var paused = Math.max(0,Date.now()-before);
        waitState.deadline += paused;
        navigationChallengeMs += paused;
      }
    }
    return fromStep;
  }

  async function handleDobStep(id) {
    banner("Filling date of birth…", "info");
    var ok = await fillDob(id.dateOfBirth);
    if (!ok) throw new Error("DOB fill failed");
    await sleep(jitter(400, 800));
    await waitFor(clickContinueLike, 15000);
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
    await waitFor(clickContinueLike, 15000);
  }

  async function handleDetailsStep(id, loginMode) {
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

    if (loginMode) {
      banner("Signing into the saved Epic account…", "info");
      await waitFor(clickContinueLike, 15000);
      return;
    }

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
      if (automation.autoSubmit && /agree|accept|terms|privacy/i.test(lbl) && !box.checked) box.click();
    }

    await sleep(jitter(500, 900));
    if (automation.autoSubmit) {
      await sw({type:'epicgen-status',sessionId:sessionId,status:'submitting'});
      banner('Submitting the completed registration…','info');
      await waitFor(clickContinueLike,15000);
    } else {
      await sw({type:'epicgen-status',sessionId:sessionId,status:'awaiting_confirmation'});
      banner('Details ready. Review the agreements and click Continue.','info');
    }
    var lastErrText = "";
    var waitState={deadline:Date.now()+120000,lastPoll:Date.now(),waitingMs:0,challengeSeen:false};
    var reportedWaitStatus="";
    var challengeState={seen:false,clearedAt:0,clicks:0};
    while (true) {
      var s = stepId();
      if (s && s !== "details" && s !== "login_password") return {waitingMs:waitState.waitingMs};
      if(serviceUnavailable())throw new Error("Epic is temporarily unavailable. This signup is preserved; recover the same account later.");
      if(challengeRejected())throw new Error("captcha_reload_required");
      var challenge = captchaVisible();
      continueAfterChallenge(challengeState, challenge);
      var wait = registrationWaitState(waitState, challenge, Date.now());
      if (wait.status !== reportedWaitStatus && (challenge || reportedWaitStatus)) {
        reportedWaitStatus = wait.status;
        await sw({type:'epicgen-status',sessionId:sessionId,status:challenge?'awaiting_captcha':automation.autoSubmit?'submitting':'awaiting_confirmation'});
        banner(challenge ? 'Waiting for Epic’s security check. Complete the challenge in this tab; this signup is preserved.' : 'Security check closed. Waiting for Epic to continue…', 'info');
      }
      if(automation.autoSubmit && wait.timedOut) throw new Error(lastErrText || "Epic did not finish registration after the security check. Recover this same signup; do not reserve another inbox.");
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
        if (!visibleEnabled(errNodes[ei])) continue;
        var t = String(errNodes[ei].innerText || errNodes[ei].textContent || "").trim();
        if (t) {
          errText += (errText ? " · " : "") + t;
        }
      }
      if (!errText) lastErrText = "";
      if (errText && errText !== lastErrText) {
        console.warn("epicgen form error:", errText);
        banner("Epic error: " + errText, "err");
        lastErrText = errText;
      }
      await sleep(600);
    }
    // Waiting for the owner must not close the form or discard the session.
  }

  async function handleOtpStep() {
    await sw({
      type: "epicgen-status",
      sessionId: sessionId,
      status: "awaiting_otp",
    });
    banner("Waiting for the Epic code in Outlook…", "info");
    var resp;
    for (var attempt=0;attempt<3;attempt++) {
    // Each explicitly requested fresh email gets its own delivery window.
    // Time spent solving the preceding challenge must not consume it.
    var deadline = Date.now() + 5 * 60 * 1000;
    resp=null;
    var mailPollStarted=Date.now(),resent=false;
    while (Date.now() < deadline) {
      resp = await sw({ type: "epicgen-request-otp", sessionId: sessionId });
      if (!resp.ok) throw new Error("otp: " + (resp.error || "unknown"));
      if (resp.code) break;
      if(!resent&&Date.now()-mailPollStarted>30000&&clickResendCode())resent=true;
      banner("Waiting for Outlook: " + (resp.error || "email has not arrived"), "info");
      await sleep(3000);
    }
    if (!resp || !/^\d{6}$/.test(String(resp.code || ""))) throw new Error("Outlook OTP timed out");
    var code = String(resp.code || "");
    banner("Verification code received — entering it…", "info");

    var boxes = document.querySelectorAll('input[name^="code-input-"], input[maxlength="1"]');
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
    await waitFor(clickContinueLike, 30000);
    await sleep(1500);
    var result = await waitForStepChange('otp', 180000);
    if (result === 'challenge_rejected') throw new Error('captcha_reload_required');
    if (result === 'auth_context_rejected') throw new Error('auth_context_reset_required');
    if (result !== 'otp_invalid') {
      if (result === 'otp') throw new Error('Email verification response timed out');
      return;
    }
    if (attempt === 2) throw new Error('Epic rejected three fresh verification codes');
    banner('Epic rejected the code. Requesting a fresh email…','info');
    await waitFor(clickResendCode, 60000);
    }
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
    automation = session.automation || {};
    banner("Epic signup for " + id.email + " — starting…", "info");
    var lastStep = null;
    var startTs = Date.now();
    var navigationChallengeStart = navigationChallengeMs;
    var maxMs = 10 * 60 * 1000;
    while (Date.now() - startTs - (navigationChallengeMs-navigationChallengeStart) < maxMs) {
      var step = stepId();
      if (step === lastStep || step === null) {
        await sleep(500);
        continue;
      }
      console.log("epicgen step ->", step);
      try {
        if(serviceUnavailable())throw new Error("Epic is temporarily unavailable. This signup is preserved; recover the same account later.");
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
        if (step === "agreement") {
          await sw({ type: "epicgen-status", sessionId: sessionId, status: "awaiting_eula" });
          prepareAgreement();
          if (automation.autoAcceptEula) {
            banner('Completing the Epic Store agreement…','info');
            await waitFor(clickAgreementAccept,30000);
            await waitForStepChange('agreement',180000);
          } else {
            banner('Review the Epic Store agreement and choose Accept to finish saving.','info');
            var manualStart=Date.now();
            while (stepId() === 'agreement') {
              if(authContextRejected())throw new Error('auth_context_reset_required');
              await sleep(500);
            }
            startTs+=Date.now()-manualStart;
          }
        }
        else if (step === "login_review_mfa" || step === "login_review_console") {
          await waitFor(function () { return clickReviewContinue(step); }, 60000);
        }
        else if (step === "dob") await handleDobStep(id);
        else if (step === "email") await handleEmailStep(id);
        else if (step === "details" || step === "login_password") {
          var detailsStart=Date.now();
          var detailsResult=await handleDetailsStep(id,session.login);
          if(!session.login&&!automation.autoSubmit)startTs+=Date.now()-detailsStart;
          else if(detailsResult)startTs+=detailsResult.waitingMs||0;
        }
        else if (step === "otp") await handleOtpStep();
        else if (step === "done") {
          await handleDone();
          return;
        }
      } catch (err) {
        if(err.message==='captcha_reload_required'){await retryChallenge();return;}
        if(err.message==='auth_context_reset_required'){await resetAuthContext();return;}
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
      var next = await waitForStepChange(step, 180000);
      if(next==='challenge_rejected'){await retryChallenge();return;}
      if(next==='auth_context_rejected'){await resetAuthContext();return;}
      if (next === step) {
        // The bounded wait expired; preserve the session for recovery.
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
    var captureError = "";
    var correctiveAction = "";
    var requiresEmailAuth = false;
    var code = await waitFor(function () {
      try {
        var pre = document.querySelector("pre");
        var raw = pre ? pre.textContent : (document.body ? document.body.textContent : "");
        try {
          var response = JSON.parse(raw);
          if (response.errorCode) {
            requiresEmailAuth = response.errorCode === "errors.com.epicgames.common.two_factor_authentication.required" && response.metadata && response.metadata.twoFactorMethod === "email";
            correctiveAction = response.metadata && response.metadata.correctiveAction || "";
            captureError = response.metadata && response.metadata.correctiveAction
              ? "Epic requires " + response.metadata.correctiveAction + " before it can issue a launcher token. The account is already created."
              : (response.message || response.errorCode);
            return "capture-error";
          }
        } catch (e) {}
        var match = raw.match(/"authorizationCode"\s*:\s*"([a-f0-9]{32})"/i);
        return match ? match[1] : null;
      } catch (e) { return null; }
    }, 30000);
    if (["EULA_ACCEPTANCE", "PRIVACY_POLICY_ACCEPTANCE"].indexOf(correctiveAction) !== -1) {
      await sw({ type: "epicgen-status", sessionId: sessionId, status: "awaiting_eula" });
      banner("Epic requires a store agreement. Opening the official review page…", "info");
      location.href = "https://store.epicgames.com/en-US/";
      return;
    }
    if (requiresEmailAuth) {
      var recovery = await sw({type:'epicgen-recover-auth',sessionId:sessionId});
      if (!recovery.ok) throw new Error(recovery.error || 'Email authentication recovery unavailable');
      banner('Epic requires email authentication. Opening sign-in to complete it…','info');
      location.href='https://accounts.epicgames.com/auth/logout';
      return;
    }
    if (captureError) throw new Error(captureError);
    var resp = await sw({
      type: "epicgen-authcode",
      sessionId: sessionId,
      code: code,
    });
    if (resp.ok) {
      banner("Account saved locally. Cloud upload is queued automatically.", "ok");
    } else {
      banner("Save failed: " + (resp.error || "unknown"), "err");
    }
  }

  (async function () {
    var s = await sw({ type: "epicgen-session-request", sessionId: sessionId });
    if (!s.ok || !s.session) return;
    sessionId = s.session.sessionId;
    var path = location.pathname || "";
    try {
      if (/\/id\/api\/redirect/i.test(path)) {
        await scrapeAuthCode(s.session);
      } else {
        await driveRegisterFlow(s.session);
        showRetry(s.session);
      }
    } catch (err) {
      banner("Signup error: " + (err && err.message), "err");
      await sw({
        type: "epicgen-abort",
        sessionId: sessionId,
        reason: err && err.message,
      });
      showRetry(s.session);
    }
  })();
})();
