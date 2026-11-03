// Only ordinary visible form controls are filled; unknown screens pause the flow.
(()=>{
  const visible=e=>!!e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  const inputs=()=>[...document.querySelectorAll('input')].filter(e=>visible(e)&&!e.disabled);
  const describe=e=>[e.id,e.name,e.placeholder,e.getAttribute('aria-label'),e.labels&&[...e.labels].map(l=>l.innerText).join(' ')].filter(Boolean).join(' ');
  const find=re=>inputs().find(e=>re.test(describe(e)));
  const set=(e,value)=>{if(!e||!value||e.value===value)return;e.focus();const prototype=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,value);for(const type of ['input','change'])e.dispatchEvent(new Event(type,{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:value.at(-1)}));e.blur();};
  const buttons=()=>[...document.querySelectorAll('button,a,[role="button"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
  const click=re=>{const b=buttons().find(e=>re.test(e.innerText.trim()));if(!b)return false;b.click();return true;};
  const phone=()=>find(/phone.?no|phone.?number|mobile|휴대전화|휴대폰|전화번호/i)||inputs().find(e=>e.type==='tel'&&!/birth|인증|code/i.test(describe(e)));
  const code=()=>find(/auth.?no|auth.?code|verify.?code|verification.?code|인증번호|인증 번호|인증코드/i)||inputs().find(e=>e.autocomplete==='one-time-code')||(/Please enter the verification code sent to/i.test(document.body.innerText)?inputs().find(e=>!describe(e).trim()&&e.type!=='password'):null);
  const country=()=>document.querySelector('button#countryCode')||[...document.querySelectorAll('select')].find(e=>visible(e)&&[...e.options].some(o=>/\+\d{1,3}/.test(o.text)));
  const heading=()=>String((document.querySelector('main h2')||document.querySelector('h2'))?.textContent||'');
  const countryMatches=(text,n)=>{
    const match=String(text).trim().match(/^(.*?)\s+(\+\d{1,4})$/);
    if(!match||match[2]!==n.prefix)return false;
    const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');
    const label=normalize(match[1]),aliases={usa:['unitedstates','unitedstatesofamerica','usa'],england:['unitedkingdom','uk'],hongkong:['hongkong','hongkongchina']};
    return [n.label,n.country,...(aliases[n.country]||[])].filter(Boolean).some(name=>normalize(name)===label);
  };
  function loggedIn(username){
    if(location.hostname!=='www.naver.com')return false;
    const hasLogout=[...document.querySelectorAll('a,button')].some(e=>visible(e)&&/^(logout|log out|로그아웃)$/i.test(e.innerText.trim()));
    return hasLogout&&(!username||document.body.innerText.toLowerCase().includes(username.toLowerCase()+'@naver.com'));
  }
  function inspect(){let signupReturn=null;
    if(location.hostname==='nid.naver.com'&&location.pathname==='/nidweb/passkey/bridge'&&new URL(location.href).searchParams.get('action')==='join'){
      const target=new URL(new URL(location.href).searchParams.get('rurl')||'/',location.origin);if(target.origin===location.origin&&target.pathname==='/account/signup/complete')signupReturn=target.href;
    }
    return{
    terms:location.hostname==='nid.naver.com'&&/\/term(?:\?|$|\/)/.test(location.pathname),
    challenge:[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|ncpt/.test(e.src))||!!find(/captcha|자동입력|보안문자/i)||/Please complete additional security verification/i.test(document.body.innerText),
    phoneReady:!!phone()&&!!country(),phoneEmpty:!!phone()&&!phone().value.trim(),phoneRejected:/Please make sure your mobile number is correct\./i.test(document.body.innerText),authenticated:loggedIn(),smsPopup:/Please enter the verification code sent to/i.test(document.body.innerText),createdUsername:location.hostname==='nid.naver.com'&&location.pathname==='/account/signup/complete'?document.body.innerText.match(/Welcome,\s*([a-z][a-z0-9_-]{4,19})/i)?.[1]||null:null,
    signupReturn,
  };}
  async function handle(m){
    if(m.type==='inspect')return inspect();
    if(m.type==='authenticated')return{ok:loggedIn(m.username)};
    if(m.type==='chzzk-login')return{ok:location.hostname==='chzzk.naver.com'&&click(/^(로그인|Sign in|Log in)$/i)};
    if(m.type==='naver-signin'){
      if(location.hostname!=='nid.naver.com'||location.pathname!=='/nidlogin.login'||inspect().challenge)return{ok:false};
      const id=find(/^id\b|ID or phone number/i),pw=inputs().find(e=>e.type==='password');
      if(!id||!pw)return{ok:false};set(id,m.identity.username);set(pw,m.identity.password);
      return{ok:click(/^(Sign in|로그인)$/i)};
    }
    if(m.type==='chzzk-status'){
      if(location.hostname!=='chzzk.naver.com')return{ok:false};
      try{const r=await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus',{credentials:'include'}),j=await r.json();return{ok:r.ok&&j.content?.loggedIn===true&&!!j.content?.userIdHash,userIdHash:j.content?.userIdHash};}catch{return{ok:false};}
    }
    if(location.hostname!=='nid.naver.com'||!location.pathname.startsWith('/account/signup/'))return{ok:false};
    if(m.type==='accept-terms'){
      if(!inspect().terms)return{ok:false};
      const required=[...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(e=>visible(e)&&/\[required\]|필수/i.test(describe(e)+' '+e.textContent)&&!/\[optional\]|선택/i.test(describe(e)+' '+e.textContent));
      if(!required.length)return{ok:false};
      let changed=false;
      for(const e of required)if(!e.checked&&e.getAttribute('aria-checked')!=='true'){e.click();changed=true;}
      return{ok:true,submitted:changed?false:click(/^(Confirm|확인)$/i)};
    }
    if(m.type==='identity'){
      const i=m.identity;
      if(/Please enter your Naver ID/i.test(heading())){
        const recommended=inputs().find(e=>e.type==='text');
        if(recommended&&!recommended.value.trim())set(recommended,i.username);
        return{ok:true,ready:!!recommended?.value.trim()};
      }
      const gender=document.querySelector('button#gender');
      if(/select your gender/i.test(heading())||!phone()&&gender&&visible(gender)){
        const other=[...buttons(),...document.querySelectorAll('[role="option"]')].find(e=>visible(e)&&/^(Other|기타)$/i.test(e.textContent.trim()));
        if(other){other.click();return{ok:true,ready:true};}
        if(gender&&visible(gender)){gender.click();return{ok:true,ready:false};}
        return{ok:false,ready:false};
      }
      const id=find(/^(id|uid|userId|username|joinId)\b|아이디|user.?id/i),pw=inputs().find(e=>e.type==='password')||find(/password|비밀번호/i),name=find(/^(name|userName|fullName)\b|이름|full.?name/i);
      set(id,i.username);set(pw,i.password);set(name,i.name);
      const birth=find(/birthday|birthdate|birth.?date|date.?of.?birth|생년월일|yyyymmdd|0000\.00\.00/i);
      if(birth&&birth.value.replace(/\D/g,'')!==i.birthday)set(birth,birth.type==='date'?i.birthday.slice(0,4)+'-'+i.birthday.slice(4,6)+'-'+i.birthday.slice(6):i.birthday);
      else {set(find(/birth.?year|출생연도|년도/i),i.birthday.slice(0,4));set(find(/birth.?month|월/i),i.birthday.slice(4,6));set(find(/birth.?day|일/i),i.birthday.slice(6));}
      return{ok:true,ready:!!(id||pw||name||birth||code()?.value)};
    }
    if(m.type==='number'){
      const p=phone(),c=country(),n=m.number;if(!p||!c)return{ok:false,error:'Phone-number controls not found. Keep this signup and fill them manually.'};
      const prefix=n.prefix;
      if(c.tagName==='BUTTON'){
        c.click();
        let option;
        for(let tries=0;tries<20;tries++){
          option=[...buttons(),...document.querySelectorAll('[role="option"]')].find(e=>e!==c&&visible(e)&&countryMatches(e.textContent,n));
          if(option)break;await new Promise(r=>setTimeout(r,100));
        }
        if(!option)return{ok:false,error:'Naver does not offer this phone country. Cancel and replace this number.'};
        option.click();await new Promise(r=>setTimeout(r,100));
      }else{
        const option=[...c.options].find(o=>o.value.replace(/^\+?/,'')===prefix.slice(1));
        if(!option)return{ok:false,error:'Naver does not offer this phone country.'};set(c,option.value);
      }
      if(!n.phone.startsWith(prefix))return{ok:false,error:'Phone prefix mismatch.'};set(phone(),n.phone.slice(prefix.length));
      const consent=[...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].find(e=>/receive verification SMS/i.test(describe(e)+' '+e.textContent));if(consent&&!consent.checked&&consent.getAttribute('aria-checked')!=='true')consent.click();
      return{ok:true};
    }
    if(m.type==='sms'){const e=code();if(!e)return{ok:false};set(e,m.code);return{ok:true};}
    if(m.type==='send-sms')return{ok:click(/^(send|send code|send verification code|verify|인증요청|인증 요청|인증번호 받기|인증번호 전송|인증번호 발송)$/i)};
    if(m.type==='back')return{ok:click(/Please enter the verification code sent to/i.test(document.body.innerText)?/^(닫기|close)$/i:/^(back|previous|change number|change phone number|edit|뒤로|이전|번호 변경|휴대전화 변경)$/i)};
    if(m.type==='advance'){
      if(inspect().terms||inspect().challenge)return{ok:false};
      return{ok:click(/^(next|continue|confirm|sign up|create account|다음|확인|가입하기|가입 완료)$/i)};
    }
    return{ok:false};
  }
  chrome.runtime.onMessage.addListener((m,_sender,reply)=>{handle(m).then(reply).catch(()=>reply({ok:false,error:'Form changed. Resume this signup manually.'}));return true;});
  function journal(kind,e){
    if(location.hostname!=='nid.naver.com'||!/^\/(account\/signup\/|nidweb\/passkey\/)/.test(location.pathname))return;
    const el=e?.target?.closest?.('input,select,button,a,[role="option"],[role="checkbox"]');
    const event={kind,page:location.href,target:el?el.tagName.toLowerCase()+'#'+(el.id||el.name||''):'page',label:el?describe(el)||el.textContent?.trim().slice(0,160):(document.querySelector('main h2')||document.querySelector('h2')||document.querySelector('h1'))?.textContent||document.title,inputType:el?.type||'',trusted:e?.isTrusted===true};
    if(el&&'value'in el&&['input','change'].includes(kind))event.value='[entered '+String(el.value||'').length+' characters]';
    chrome.runtime.sendMessage({type:'log-event',event}).catch(()=>{});
  }
  document.addEventListener('click',e=>journal('click',e),true);
  document.addEventListener('change',e=>journal('change',e),true);
  let inputTimer;document.addEventListener('input',e=>{clearTimeout(inputTimer);inputTimer=setTimeout(()=>journal('input',e),250);},true);
  let lastStep='';const recordStep=()=>{const step=location.pathname+' '+(document.querySelector('main h2')||document.querySelector('h2')||document.querySelector('h1'))?.textContent;if(step!==lastStep){lastStep=step;journal('step');}};
  new MutationObserver(recordStep).observe(document.body,{childList:true,subtree:true});recordStep();
  let pending=false;setInterval(async()=>{if(pending)return;pending=true;try{await chrome.runtime.sendMessage({type:'tick'});}catch{}finally{pending=false;}},1000);
})();
