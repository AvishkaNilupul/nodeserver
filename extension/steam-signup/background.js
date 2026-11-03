const BASE='http://127.0.0.1:4108';
const inflight=new Set(),authAttempts=new Map();
async function api(path,body){
  const {localToken}=await chrome.storage.session.get('localToken');
  if(!localToken)throw Error('Open the local generator and connect the extension');
  const r=await fetch(BASE+path,{method:body===undefined?'GET':'POST',headers:{'X-Local-Token':localToken,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  let result;try{result=await r.json();}catch{}
  if(!r.ok||!result?.ok)throw Error(result?.error||'Local generator rejected the request. Reopen its page or resume the signup.');
  return result;
}
async function clearProxy(){try{await chrome.proxy.settings.clear({scope:'incognito_session_only'});}catch{}authAttempts.clear();}
async function prerequisites(){
  const privateAllowed=await new Promise(resolve=>chrome.extension.isAllowedIncognitoAccess(resolve));
  if(!privateAllowed)throw Error('Enable Allow in Incognito for Steam Signup before starting. No inbox was reserved.');
  if((await chrome.windows.getAll()).some(w=>w.incognito))throw Error('Close existing Incognito windows before starting. No inbox was reserved.');
  const control=await chrome.proxy.settings.get({incognito:true});
  if(['controlled_by_other_extensions','not_controllable'].includes(control.levelOfControl))throw Error('Another extension or policy controls the private proxy. No inbox was reserved.');
}
async function handle(message,sender){
  if(sender.id!==chrome.runtime.id)throw Error('Untrusted sender');
  if(message.type==='captcha-frame'){
    const {active}=await chrome.storage.session.get('active');
    let u;try{u=new URL(sender.url);}catch{return {ok:false};}
    const parameters=new URLSearchParams(u.hash.slice(1));
    const assigned=active&&sender.tab?.id===active.tabId&&sender.frameId>0;
    const checkbox=u.origin==='https://newassets.hcaptcha.com'&&parameters.get('frame')==='checkbox'&&parameters.get('host')==='store.steampowered.com'&&parameters.get('sitekey')==='e18a349a-46c2-46a0-87a8-74be79345c92';
    if(assigned&&checkbox){active.captchaReady=true;await chrome.storage.session.set({active});}
    return {ok:!!(assigned&&checkbox),autoClick:!!(assigned&&checkbox&&active.session.automation?.autoClickCaptcha&&!active.automationHalted)};
  }
  if(sender.frameId!==0)throw Error('Untrusted sender');
  const fromLocal=sender.url===BASE+'/'&&sender.tab;
  if(fromLocal&&message.type==='connect'){
    if(!/^[A-Za-z0-9_-]{43}$/.test(message.token||''))throw Error('Invalid local connection');
    await chrome.storage.session.set({localToken:message.token});await api('/api/state');
    return {ok:true,version:chrome.runtime.getManifest().version};
  }
  if(fromLocal&&message.type==='status'){
    const {active,pending,lastError}=await chrome.storage.session.get(['active','pending','lastError']);
    return {ok:true,busy:!!(active||pending),lastError:lastError||''};
  }
  if(fromLocal&&['start','resume'].includes(message.type)){
    if(inflight.has('start'))throw Error('A signup is already opening');inflight.add('start');
    let win;
    try{
      await prerequisites();
      const {active,pending}=await chrome.storage.session.get(['active','pending']);
      if(active||pending){const prior=active||pending;try{await chrome.tabs.get(prior.tabId);throw Error('Close the previous Steam signup window before resuming');}catch(e){if(e.message.startsWith('Close'))throw e;}}
      const state=await api('/api/state');
      if(message.type==='start'&&state.active)throw Error('Resume the existing signup');
      const country=message.type==='resume'?(state.active?.requestedCountry||state.active?.country):message.country;
      if(!/^[A-Z]{2}$/.test(country||''))throw Error('Choose a country first');
      const prepared=await api('/api/proxy/prepare',{country});
      // The browser itself must prove it uses the same sticky exit before allocation.
      win=await chrome.windows.create({url:'about:blank',focused:true,type:'normal',incognito:true});
      if(!win.tabs?.[0])throw Error('Could not open the private proxy check');
      await chrome.proxy.settings.set({scope:'incognito_session_only',value:{mode:'fixed_servers',rules:{singleProxy:{scheme:prepared.proxy.scheme,host:prepared.proxy.host,port:prepared.proxy.port},bypassList:['localhost','127.0.0.1','[::1]']}}});
      await chrome.storage.session.set({pending:{...prepared,country,mode:message.type,sampleContact:message.sampleContact===true,autoSubmit:message.autoSubmit===true,tabId:win.tabs[0].id,windowId:win.id},lastError:''});
      await chrome.storage.session.remove('active');
      await chrome.tabs.update(win.tabs[0].id,{url:'https://ipwho.is/'});return {ok:true};
    }catch(e){if(win){await chrome.windows.remove(win.id).catch(()=>{});await chrome.storage.session.remove('pending');await clearProxy();}throw e;}
    finally{inflight.delete('start');}
  }
  const {active,pending}=await chrome.storage.session.get(['active','pending']);
  if(message.type==='proxy-observed'&&pending&&sender.tab?.id===pending.tabId&&sender.url==='https://ipwho.is/'){
    if(inflight.has('probe'))return {ok:true};inflight.add('probe');
    try{
      const result=await api(pending.mode==='resume'?'/api/resume':'/api/start',{ticket:pending.ticket,browserLocation:message.location,sampleContact:pending.sampleContact,autoSubmit:pending.autoSubmit});
      await chrome.storage.session.set({active:{session:result.session,proxy:pending.proxy,tabId:pending.tabId,windowId:pending.windowId},lastError:''});
      await chrome.storage.session.remove('pending');
      await chrome.tabs.update(pending.tabId,{url:'https://store.steampowered.com/join/'});return {ok:true};
    }catch(e){await chrome.storage.session.set({lastError:e.message});await chrome.storage.session.remove('pending');await chrome.windows.remove(pending.windowId).catch(()=>{});await clearProxy();throw e;}
    finally{inflight.delete('probe');}
  }
  if(!active||sender.tab?.id!==active.tabId||!sender.url?.startsWith('https://store.steampowered.com/'))return {ok:false,error:'This tab is not assigned to a signup'};
  if(message.type==='identity'){
    if(!new URL(sender.url).pathname.startsWith('/join/'))return {ok:false};
    const {proxy,...identity}=active.session;return {ok:true,identity};
  }
  if(message.type==='captcha-retry'){
    const page=new URL(sender.url);
    if(page.pathname!=='/join/'||!active.session.automation?.autoSubmit||!['not-loaded','invalid-response'].includes(message.reason))return {ok:false};
    if(message.reason==='not-loaded'&&active.captchaReady)return {ok:true,waiting:true};
    if((active.captchaRetries||0)>=2)throw Error('CAPTCHA could not be loaded after two retries');
    active.captchaRetries=(active.captchaRetries||0)+1;active.captchaReady=false;
    await chrome.storage.session.set({active});await chrome.tabs.reload(active.tabId);return {ok:true,reloading:true};
  }
  if(message.type==='automation-failed'){
    active.automationHalted=true;
    await chrome.storage.session.set({active,lastError:String(message.error||'Steam stopped this signup').slice(0,500)});
    return {ok:true};
  }
  if(message.type==='country'){
    if(!new URL(sender.url).pathname.startsWith('/join/')||!/^[A-Z]{2}$/.test(message.country||''))return {ok:false};
    await api('/api/session/'+active.session.id+'/country',{country:message.country});return {ok:true};
  }
  if(message.type==='verification'){
    if(active.verificationOpened)return {ok:true,opened:true};
    if(inflight.has(active.session.id))return {ok:true,opened:false};inflight.add(active.session.id);
    try{
      const result=await api('/api/session/'+active.session.id+'/verification',{});if(!result.url)return {ok:true,opened:false};
      const u=new URL(result.url);
      if(u.origin!=='https://store.steampowered.com'||u.pathname!=='/account/newaccountverification'||!u.searchParams.has('stoken')||!u.searchParams.has('creationid'))throw Error('Invalid Steam verification URL');
      // Open blank first so proxy authentication is bound before the request starts.
      const tab=await chrome.tabs.create({url:'about:blank',windowId:active.windowId,active:false});
      active.verificationOpened=true;active.verificationTabId=tab.id;await chrome.storage.session.set({active});
      await chrome.tabs.update(tab.id,{url:u.href});return {ok:true,opened:true};
    }finally{inflight.delete(active.session.id);}
  }
  if(message.type==='complete'&&new URL(sender.url).origin==='https://store.steampowered.com'&&new URL(sender.url).pathname==='/'&&new URL(sender.url).searchParams.get('created_account')==='1'){
    await api('/api/session/'+active.session.id+'/complete',{url:'https://store.steampowered.com/?created_account=1'});
    await chrome.storage.session.remove('active');await chrome.windows.remove(active.windowId).catch(()=>{});await clearProxy();return {ok:true};
  }
  return {ok:false};
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{handle(m,s).then(reply).catch(e=>reply({ok:false,error:e.message}));return true;});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:BASE+'/'}));
chrome.webRequest.onAuthRequired.addListener((details,respond)=>{
  (async()=>{
    const {active,pending}=await chrome.storage.session.get(['active','pending']);const owner=active||pending,p=owner?.proxy;
    const tabs=[owner?.tabId,active?.verificationTabId].filter(Number.isInteger);
    if(!p||!details.isProxy||details.challenger?.host!==p.host||Number(details.challenger?.port)!==p.port||!tabs.includes(details.tabId))return respond({});
    const count=(authAttempts.get(details.requestId)||0)+1;authAttempts.set(details.requestId,count);
    if(count>2)return respond({cancel:true});respond({authCredentials:{username:p.username,password:p.password}});
  })().catch(()=>respond({cancel:true}));
},{urls:['<all_urls>']},['asyncBlocking']);
for(const event of [chrome.webRequest.onCompleted,chrome.webRequest.onErrorOccurred])event.addListener(d=>authAttempts.delete(d.requestId),{urls:['<all_urls>']});
chrome.windows.onRemoved.addListener(async id=>{
  const {active,pending}=await chrome.storage.session.get(['active','pending']);
  if(active?.windowId===id||pending?.windowId===id){await chrome.storage.session.remove(['active','pending']);await clearProxy();}
});
