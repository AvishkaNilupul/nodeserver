(async()=>{
  const send=message=>chrome.runtime.sendMessage(message);
  const visible=el=>!!el && el.getClientRects().length>0;
  function fill(el,value) {
    if(!el||el.value===value)return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
    // Steam runs password availability checks from its inline keyup handlers.
    el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Tab',code:'Tab'}));
    if(typeof CustomEvent==='function')el.dispatchEvent(new CustomEvent('steam-signup-field-keyup',{bubbles:true}));
  }
  let identity, busy=false, nextPoll=0, completed=false, selectedCountry=null, countryReported=null, automationHalted=false, nextFrameCheck=Date.now()+30000, revealedCaptcha=false;
  const flow=globalThis.SteamSignupFlow?.create({document,visible,click:el=>{if(el.getAttribute('href')?.startsWith('javascript:'))el.dispatchEvent(new CustomEvent('steam-signup-routine-click',{bubbles:true}));else el.click();}});
  async function progress(result){
    if(result?.state==='failed'){
      if(/captcha/i.test(result.message)&&!/too many/i.test(result.message)){const retry=await send({type:'captcha-retry',reason:'invalid-response'});if(retry?.ok&&retry.reloading){automationHalted=true;notice('Retrying the CAPTCHA with the same inbox. Solve a challenge only if one appears.');return;}}
      automationHalted=true;await send({type:'automation-failed',error:result.message});notice(result.message+' · This signup is preserved for recovery.');
    }
  }
  const badge=document.createElement('div');
  badge.style.cssText='pointer-events:none;position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:400px;padding:12px 16px;background:#11253a;color:#fff;font:14px system-ui;border:1px solid #5aa9df;border-radius:8px;box-shadow:0 4px 20px #0006';
  const notice=text=>{badge.textContent='Steam Signup · '+text;if(!badge.isConnected)document.body.append(badge);};
  async function step() {
    if(busy || completed || automationHalted)return;busy=true;
    try {
      if(location.origin==='https://store.steampowered.com' && location.pathname==='/' && new URL(location.href).searchParams.get('created_account')==='1') {
        const result=await send({type:'complete'});
        if(result?.ok){notice('Account created and saved in the encrypted local vault.');completed=true;}
        return;
      }
      if(!location.pathname.startsWith('/join/'))return;
      if(!identity){const r=await send({type:'identity'});if(!r?.ok)return;identity=r.identity;}
      // Steam's age dialog hides the email form. Handle it before inspecting fields.
      if(identity.automation?.autoSubmit===true && flow?.routineDialogs())return;
      // The email overlay is a successful registration submission, not a stalled form.
      if(/waiting for you to verify/i.test(document.body.innerText)) {
        if(Date.now()>=nextPoll){
          nextPoll=Date.now()+6000;
          const r=await send({type:'verification'});
          notice(r?.ok?(r.opened?'Verification email opened in a background tab.':'Waiting for a fresh Steam verification email.'):(r?.error||'Email reader unavailable; retrying.'));
        }
        return;
      }
      const fields=Array.from(document.querySelectorAll('input')).filter(visible);
      if(location.pathname.startsWith('/join/completesignup')) {
        const text=fields.find(x=>!['password','hidden','checkbox','submit'].includes(x.type) && /account|user/i.test(x.name+' '+x.id));
        const passwords=fields.filter(x=>x.type==='password');
        if(text && passwords.length===2) {
          fill(text,identity.username);fill(passwords[0],identity.password);fill(passwords[1],identity.password);
          const automatic=identity.automation?.autoSubmit===true;
          document.dispatchEvent(new CustomEvent('steam-signup-validation'));
          const passwordAvailable=passwords[0].getAttribute('data-steam-password-available')==='true';
          const result=flow?.credentials({allowed:automatic,passwordAvailable,valuesMatch:text.value===identity.username&&passwords.every(el=>el.value===identity.password)});
          notice(automatic?'Finishing this account after Steam validates the credentials.':'Credentials filled. Review and click Done to create this account.');
          await progress(result);
        }else notice('Waiting for the account-name and password form.');
        return;
      }
      const emailFields=fields.filter(x=>x.type==='email' || /email/i.test(x.name+' '+x.id));
      if(emailFields.length>=2) {
        // An existing signed-in account must not be reused for another signup.
        if(document.querySelector('#account_pulldown')){notice('Sign out in this testing profile before continuing.');return;}
        const select=document.querySelector('select#country');
        if(select && selectedCountry===null){
          if(!Array.from(select.options).some(o=>o.value===identity.requestedCountry)){notice('Steam does not offer this country. Keep this signup for recovery.');return;}
          select.value=identity.requestedCountry;select.dispatchEvent(new Event('change',{bubbles:true}));selectedCountry=identity.requestedCountry;
        }
        if(select && select.value!==countryReported){const r=await send({type:'country',country:select.value});if(r?.ok)countryReported=select.value;}
        if(select && select.value!==identity.requestedCountry){notice('Country differs from the verified proxy. Select '+identity.requestedCountry+' before continuing.');return;}
        fill(emailFields[0],identity.email);fill(emailFields[1],identity.email);
        const widget=document.querySelector('iframe[src*="hcaptcha.com"][src*="frame=checkbox"]');
        if(widget&&!revealedCaptcha){widget.scrollIntoView({block:'center'});revealedCaptcha=true;}
        const automatic=identity.automation?.autoSubmit===true&&identity.automation?.autoAcceptAgreement===true;
        const captchaToken=document.querySelector('textarea[name="h-captcha-response"]')?.value||document.querySelector('textarea[name="g-recaptcha-response"]')?.value||'';
        const result=flow?.registration({allowed:automatic,countryReady:!!select&&countryReported===identity.requestedCountry&&select.value===identity.requestedCountry,captchaToken});
        notice(automatic?(captchaToken?'Continuing this signup automatically.':'Solve the CAPTCHA if an image or puzzle appears. The remaining steps continue automatically.'):'Email filled. Complete the CAPTCHA, review the agreement, then click Continue.');
        await progress(result);
        if(automatic&&!captchaToken&&!automationHalted&&Date.now()>=nextFrameCheck){
          nextFrameCheck=Date.now()+30000;
          const r=await send({type:'captcha-retry',reason:'not-loaded'});
          if(!r?.ok){await progress({state:'failed',message:r?.error||'The CAPTCHA did not load'});}
          else if(r.reloading)automationHalted=true;
        }
      }
    }catch {notice('Connection interrupted. Reopen the generator and resume this signup.');}
    finally{busy=false;}
  }
  await step();setInterval(step,1500);
})();
