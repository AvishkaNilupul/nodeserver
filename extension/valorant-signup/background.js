const BASE='http://127.0.0.1:4110';
async function finish(active) {
  if(inflight.has('finish'))return;
  inflight.add('finish');
  try {
    await api('/api/session/'+active.session.id+'/complete',{evidence:active.completionEvidence});
    await chrome.storage.session.remove('active');
    await chrome.storage.session.set({lastError:''});
    await chrome.windows.remove(active.windowId).catch(()=>{});await clearProxy();
  } finally {inflight.delete('finish');}
}
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
  if(!privateAllowed)throw Error('Enable Allow in Incognito for Valorant Signup before starting. No inbox was reserved.');
  if((await chrome.windows.getAll()).some(w=>w.incognito))throw Error('Close existing Incognito windows before starting. No inbox was reserved.');
  const control=await chrome.proxy.settings.get({incognito:true});
  if(['controlled_by_other_extensions','not_controllable'].includes(control.levelOfControl))throw Error('Another extension or policy controls the private proxy. No inbox was reserved.');
}
async function handle(message,sender){
  if(sender.id!==chrome.runtime.id)throw Error('Untrusted sender');
  if(sender.frameId!==0)throw Error('Untrusted sender');
  const fromLocal=sender.url===BASE+'/'&&sender.tab;
  if(fromLocal&&message.type==='connect'){
    if(!/^[A-Za-z0-9_-]{43}$/.test(message.token||''))throw Error('Invalid local connection');
    await chrome.storage.session.set({localToken:message.token});await api('/api/state');
    return {ok:true,version:chrome.runtime.getManifest().version};
  }
  if(fromLocal&&message.type==='status'){
    let {active,pending,lastError}=await chrome.storage.session.get(['active','pending','lastError']);
    if(active?.completionEvidence){try{await finish(active);active=null;lastError='';}catch{lastError='Account created; saving is pending. Keep the creator page open.';}}
    return {ok:true,busy:!!(active||pending),lastError:lastError||''};
  }
  if(fromLocal&&['start','resume'].includes(message.type)){
    if(inflight.has('start'))throw Error('A signup is already opening');inflight.add('start');
    let win;
    try{
      await prerequisites();
      const {active,pending}=await chrome.storage.session.get(['active','pending']);
      if(active||pending){const prior=active||pending;try{await chrome.tabs.get(prior.tabId);throw Error('Close the previous Valorant signup window before resuming');}catch(e){if(e.message.startsWith('Close'))throw e;}}
      const state=await api('/api/state');
      if(message.type==='start'&&state.active)throw Error('Resume the existing signup');
      const country=message.type==='resume'?(state.active?.requestedCountry||state.active?.country):message.country;
      if(!/^[A-Z]{2}$/.test(country||''))throw Error('Choose a country first');
      const prepared=await api('/api/proxy/prepare',{country});
      // The browser itself must prove it uses the same sticky exit before allocation.
      win=await chrome.windows.create({url:'about:blank',focused:true,type:'normal',incognito:true});
      if(!win.tabs?.[0])throw Error('Could not open the private proxy check');
      await chrome.proxy.settings.set({scope:'incognito_session_only',value:{mode:'fixed_servers',rules:{singleProxy:{scheme:prepared.proxy.scheme,host:prepared.proxy.host,port:prepared.proxy.port},bypassList:['localhost','127.0.0.1','[::1]']}}});
      await chrome.storage.session.set({pending:{...prepared,country,mode:message.type,tabId:win.tabs[0].id,windowId:win.id},lastError:''});
      await chrome.storage.session.remove('active');
      await chrome.tabs.update(win.tabs[0].id,{url:'https://ipwho.is/'});return {ok:true};
    }catch(e){if(win){await chrome.windows.remove(win.id).catch(()=>{});await chrome.storage.session.remove('pending');await clearProxy();}throw e;}
    finally{inflight.delete('start');}
  }
  const {active,pending}=await chrome.storage.session.get(['active','pending']);
  if(message.type==='proxy-observed'&&pending&&sender.tab?.id===pending.tabId&&sender.url==='https://ipwho.is/'){
    if(inflight.has('probe'))return {ok:true};inflight.add('probe');
    try{
      const result=await api(pending.mode==='resume'?'/api/resume':'/api/start',{ticket:pending.ticket,browserLocation:message.location});
      await chrome.storage.session.set({active:{session:result.session,proxy:pending.proxy,tabId:pending.tabId,windowId:pending.windowId},lastError:''});
      await chrome.storage.session.remove('pending');
      await chrome.tabs.update(pending.tabId,{url:'https://xsso.playvalorant.com/login?uri=https%3A%2F%2Fplayvalorant.com%2Fen-us%2Fplatform-selection%2F&prompt=signup&show_region=true&locale=en_US'});return {ok:true};
    }catch(e){await chrome.storage.session.set({lastError:e.message});await chrome.storage.session.remove('pending');await chrome.windows.remove(pending.windowId).catch(()=>{});await clearProxy();throw e;}
    finally{inflight.delete('probe');}
  }
  if(!active || sender.tab?.id!==active.tabId || new URL(sender.url).origin!=='https://authenticate.riotgames.com') return {ok:false,error:'This tab is not assigned to a signup'};
  if(message.type==='identity') {
    const {proxy,...identity}=active.session;return {ok:true,identity};
  }
  if(message.type==='stage') {
    if(message.stage==='failed') await chrome.storage.session.set({lastError:'Riot stopped this signup. Check its window and resume the same identity.'});
    await api('/api/session/'+active.session.id+'/stage',{stage:message.stage}); return {ok:true};
  }
  if(message.type==='verification') return api('/api/session/'+active.session.id+'/verification',{});
  if(message.type==='riot-result') {
    const receipt=message.receipt;
    if(!receipt || !['signup','verification'].includes(receipt.requestType))return {ok:false};
    if(receipt.type==='error') {
      const code=/^[a-z0-9_-]{1,100}$/i.test(receipt.errorCode||'')?receipt.errorCode:'request rejected';
      await chrome.storage.session.set({lastError:'Riot signup: '+code+'. Keep this identity to resume.'});return {ok:true};
    }
    if(receipt.requestType==='signup') {
      if(receipt.username!==active.session.username)return {ok:false};
      if(['success','verification'].includes(receipt.type)) {
        active.signupObserved=true;await chrome.storage.session.set({active});
      }
    }
    if(receipt.type==='success' && active.signupObserved) {
      active.completionEvidence={source:'riot-signup-response',type:'success',username:active.session.username};
      await chrome.storage.session.set({active}); await finish(active);return {ok:true};
    }
    return {ok:true};
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
