// Normal Steam form progression. CAPTCHA answers and validation stay with Steam.
(function(root){
  function create({document,now=Date.now,visible=el=>!!el&&el.getClientRects().length>0,click=el=>el.click()}={}){
    let submitted=false,submittedAt=0,readySince=null,readyKey=null,stage=null;
    const text=el=>String(el?.innerText||el?.textContent||el?.value||'').trim();
    const enabled=el=>visible(el)&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true';
    const clickedDialogs=new WeakSet();
    function routineDialogs(){
      const controls=Array.from(document.querySelectorAll?.('a,button,input[type="button"],input[type="submit"]')||[]);
      for(const el of controls){
        const label=text(el).replace(/\s+/g,' ');
        if(enabled(el)&&!clickedDialogs.has(el)&&(/^I am 16 years of age or older$/i.test(label)||/^Reject all(?: optional cookies)?$/i.test(label))){clickedDialogs.add(el);click(el);return true;}
      }
      return false;
    }
    const error=()=>{const e=document.querySelector('#error_display');return visible(e)?text(e):'';};
    function begin(next){if(stage!==next){stage=next;submitted=false;readySince=null;readyKey=null;}}
    function settled(key){if(key!==readyKey){readyKey=key;readySince=now();return false;}return now()-readySince>=1000;}
    function failed(message){return {state:'failed',message};}
    function registration({allowed,countryReady,captchaToken}){
      begin('registration');
      if(!allowed)return {state:'manual'};
      if(routineDialogs())return {state:'handled-dialog'};
      const problem=error();if(problem)return failed(problem);
      if(submitted)return now()-submittedAt>90000?failed('Steam did not respond to the form submission'): {state:'submitted'};
      if(!countryReady)return {state:'waiting-country'};
      const agree=document.querySelector('#i_agree_check');
      if(!agree)return {state:'waiting-form'};
      if(!agree.checked){click(agree);if(!agree.checked)return {state:'waiting-form'};}
      if(!captchaToken){readyKey=null;return {state:'waiting-captcha'};}
      const button=document.querySelector('#createAccountButton');
      if(!enabled(button)||!settled(captchaToken))return {state:'waiting-validation'};
      submitted=true;submittedAt=now();click(button);return {state:'submitted'};
    }
    function credentials({allowed,valuesMatch,passwordAvailable=false}){
      begin('credentials');
      if(!allowed)return {state:'manual'};
      if(routineDialogs())return {state:'handled-dialog'};
      const problem=error();if(problem)return failed(problem);
      if(submitted)return now()-submittedAt>90000?failed('Steam did not respond to the form submission'): {state:'submitted'};
      if(!valuesMatch)return {state:'waiting-form'};
      const account=document.querySelector('#accountname_availability'),password=document.querySelector('#password_tag');
      const nameReady=visible(account)&&/\bavailable\b/i.test(text(account))&&!/not|unavailable/i.test(text(account));
      // Strong passwords hide the status tag; the page bridge supplies Steam's
      // actual availability result. Visible status classes support older pages.
      const passwordReady=passwordAvailable||!!password&&(password.classList?.contains('good')||password.classList?.contains('warning'));
      if(!nameReady||!passwordReady){readyKey=null;return {state:'waiting-validation'};}
      const button=Array.from(document.querySelectorAll('a,button,input[type="submit"]')).find(el=>/^done$/i.test(text(el)));
      if(!enabled(button)||!settled('validated'))return {state:'waiting-validation'};
      submitted=true;submittedAt=now();click(button);return {state:'submitted'};
    }
    return {registration,credentials,routineDialogs};
  }
  if(typeof module==='object'&&module.exports)module.exports={create};else root.SteamSignupFlow={create};
})(globalThis);
