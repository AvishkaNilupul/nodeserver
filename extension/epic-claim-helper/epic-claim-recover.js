// Reconnect an existing account. Credentials exist only in this assigned tab's
// session job and are sent only to Epic's ordinary sign-in form.
(async()=>{
 const context=await chrome.runtime.sendMessage({type:'epicclaim-context'}).catch(()=>null);
 if(!context?.ok||context.job?.mode!=='recover')return;
 const job=context.job;let done=false,busy=false,lastClick=0,lastCode='';const clicked=new Map();
 const visible=el=>!!el&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden';
 const report=async(status,error='',code)=>{if(done)return;done=true;await chrome.runtime.sendMessage({type:'epicclaim-result',status,error,...(code?{code}:{})});};
 function setValue(el,value){if(!el||el.value===value)return;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
 const redirect='https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code';
 const timer=setInterval(async()=>{
  if(done){clearInterval(timer);return;}if(busy)return;busy=true;
  try{
   const text=document.body?.innerText||'';
   if(location.pathname==='/id/api/redirect') {
    let data;try{data=JSON.parse(document.querySelector('pre')?.textContent||document.body.textContent);}catch{return;}
    if(/^[a-f\d]{32}$/i.test(data.authorizationCode||''))return report('reauthorized','',data.authorizationCode);
    if(data.errorCode)return report('error','Epic requires another sign-in step: '+String(data.metadata?.correctiveAction||data.errorCode).slice(0,100));
    return;
   }
   if(/one more step|please complete a security check|confirm you.re human/i.test(text))return report('needs_captcha','Epic requested a visible sign-in security check');
   if(/incorrect (email|password)|invalid (email|password)|credentials (are )?invalid/i.test(text))return report('error','Epic rejected the saved sign-in details');
   if(!location.pathname.startsWith('/id/')){location.href=redirect;return;}
   if(/\/review\/mfa-settings/.test(location.pathname)) {
    const confirm=[...document.querySelectorAll('button')].find(b=>visible(b)&&!b.disabled&&/^confirm$/i.test(b.innerText.trim()));
    if(confirm&&Date.now()-lastClick>7000){lastClick=Date.now();confirm.click();}return;
   }
   if(/\/review\/link-console/.test(location.pathname)) {
    const proceed=[...document.querySelectorAll('button')].find(b=>visible(b)&&!b.disabled&&/^(continue|done linking)$/i.test(b.innerText.trim()));
    if(proceed&&Date.now()-lastClick>7000){lastClick=Date.now();proceed.click();}return;
   }
   if(/\/review\//.test(location.pathname))return report('error','Epic requires an account review before issuing a login code');
   const inputs=[...document.querySelectorAll('input')].filter(visible);
   const otp=inputs.filter(i=>/^code-input-/.test(i.name)||i.maxLength===1);
   const singleOtp=inputs.find(i=>i.autocomplete==='one-time-code');
   let filledOtp=false;
   if(otp.length>=6||singleOtp) {
    if(!lastCode) {
     const result=await chrome.runtime.sendMessage({type:'epicclaim-otp'});
     if(!/^\d{6}$/.test(result?.code||''))return;
     lastCode=result.code;
     if(otp.length>=6)otp.slice(0,6).forEach((el,i)=>setValue(el,result.code[i]));else setValue(singleOtp,result.code);
    }
    // React may enable Continue only after this tick. Keep trying the button
    // without repeatedly fetching or re-entering the same email code.
    filledOtp=true;
   }else{
    const email=inputs.find(i=>i.type==='email'||i.name==='email'||i.id==='email');
    const password=inputs.find(i=>i.type==='password');
    if(email)setValue(email,job.email);
    if(password)setValue(password,job.password);
   }
   const button=[...document.querySelectorAll('button')].find(b=>visible(b)&&!b.disabled&&/^(continue|sign in|log in|verify|sign in with epic games)$/i.test(b.innerText.trim()));
   if(!button)return;
   const key=location.pathname+'|'+button.innerText.trim()+'|'+inputs.map(i=>i.type).join(',')+'|'+filledOtp;
   if(Date.now()-lastClick<7000||(clicked.get(key)||0)>=2)return;
   lastClick=Date.now();clicked.set(key,(clicked.get(key)||0)+1);button.click();
  }catch{await report('error','Could not complete the assigned sign-in form');}finally{busy=false;}
 },2000);
 setTimeout(()=>{clearInterval(timer);report('error','Sign-in needs attention in the assigned Epic tab');},220000);
})();
