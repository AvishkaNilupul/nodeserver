(function(root) {
  function create({document, now = Date.now, visible = el => !!el && el.getClientRects().length > 0} = {}) {
    const query = selector => [...document.querySelectorAll(selector)].find(visible);
    let lastKey = '', readyAt = 0, clickedKey = '', clickedAt = 0;
    function set(el, value) {
      if (!el || el.value === value) return;
      const prototype = el.tagName === 'SELECT' ? root.HTMLSelectElement?.prototype : root.HTMLInputElement?.prototype;
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      const EventClass = document.defaultView?.Event || root.Event;
      el.dispatchEvent(new EventClass('input', {bubbles: true}));
      el.dispatchEvent(new EventClass('change', {bubbles: true}));
      el.dispatchEvent(new EventClass('blur', {bubbles: true}));
    }
    function click(el) {
      el.scrollIntoView?.({block: 'center'}); el.focus?.(); el.click();
    }
    function step(identity, code) {
      const cookieClose = query('button[aria-label="Close this consent banner"]');
      if (cookieClose) {click(cookieClose); return {stage: 'challenge'};}
      // Selectors are from Riot's shipped rso-authenticator-ui, checked 2026-11-04.
      let stage, ready = true;
      const email = query('input[name="email_address"]');
      const username = query('input[name="username"]');
      const password = query('input[name="password"]');
      const confirm = query('input[name="password-confirm"]');
      const date = query('[data-testid="riot-signup-birthdate"], [data-testid="input-birthday"]');
      const terms = query('[data-testid="btn-accept-tos"], input#tos-checkbox, input[name="tou_agree"]');
      const otp = query('[data-testid="otp-input"], [data-testid="verification-input"], input[autocomplete="one-time-code"]');
      if (email) {stage = 'email'; set(email, identity.email);}
      else if (date) {
        stage = 'birthdate'; const [year, month, day] = identity.birthDate.split('-');
        const fields = [...date.querySelectorAll('input')].filter(visible);
        const values = {YYYY: year, MM: month, DD: day};
        ready = fields.length === 3;
        for (const field of fields) {
          const key = (field.placeholder || '').toUpperCase();
          if (!values[key]) {ready = false; continue;} set(field, values[key]);
        }
      } else if (username && !password) {stage = 'username'; set(username, identity.username);}
      else if (password) {
        stage = 'password'; if (username) set(username, identity.username);
        set(password, identity.password); if (confirm) set(confirm, identity.password);
        ready = !!confirm;
      } else if (terms) {
        stage = 'terms';
        const area = document.querySelector('#tos-scrollable-area');
        if (area && area.scrollTop + area.clientHeight < area.scrollHeight - 30) {
          area.scrollTop = area.scrollHeight;
          area.dispatchEvent(new (document.defaultView?.Event || root.Event)('scroll', {bubbles: true}));
          return {stage};
        }
      } else if (otp) {
        stage = 'verification';
        if (!/^\d{6}$/.test(code || '')) return {stage};
        const fields = otp.tagName === 'INPUT' ? [otp] : [...otp.querySelectorAll('input')].filter(visible);
        if (fields.length === 6) fields.forEach((el,index) => set(el, code[index]));
        else if (fields.length === 1) set(fields[0], code);
        else return {stage};
      }
      else return {stage: 'challenge'};
      for (const optional of document.querySelectorAll('input#newsletter, input[name="newsletter"], input[name="third_party_opt_in"]')) {
        if (optional.checked) optional.click();
      }
      const agreement = query('input#tos-checkbox, input[name="tou_agree"]');
      if (agreement && !agreement.checked && !agreement.disabled) click(agreement);
      const button = query('[data-testid="btn-accept-tos"], [data-testid="btn-signup-submit"], [data-testid="btn-otp-submit"]');
      const key = stage + ':' + (button?.dataset?.testid || '');
      if (key !== lastKey) {lastKey = key; readyAt = now(); clickedKey = '';}
      if (clickedKey === key) return now() - clickedAt > 15000 ? {stage: 'needs-action'} : {stage: 'submitted'};
      if (!ready || !button || button.disabled || button.getAttribute('aria-disabled') === 'true' || now() - readyAt < 1200) return {stage};
      const error = query('[role="alert"], [data-testid="error-text"]');
      if (error?.textContent?.trim()) return {stage: 'failed'};
      clickedKey = key; clickedAt = now(); click(button); return {stage};
    }
    return {step, set};
  }
  if (typeof module === 'object' && module.exports) module.exports = {create}; else root.ValorantSignupFlow = {create};
})(globalThis);
