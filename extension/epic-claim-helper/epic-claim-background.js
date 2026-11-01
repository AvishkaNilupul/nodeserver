// Jobs are authenticated locally, assigned to exactly one tab, and run serially.
const CLAIM_STATE='epicclaim.connection',CLAIM_JOB='epicclaim.job';
// The checkout page answers by CHECKOUT_MS after the job starts; a tab that
// still hasn't by STUCK_MS is reported from here. Both land before the
// bridge's own 180 s limit, so the reason reaches the server.
const CHECKOUT_MS=120000,STUCK_MS=130000,RECOVER_STUCK_MS=230000;
let claimPolling=false;
// Host, path and hash route only: the exchange URL's query holds a login code.
function tabPlace(tab) {
 if(!tab)return 'tab was closed';
 let place='unknown page';
 try{const u=new URL(tab.pendingUrl||tab.url||'');place=u.protocol==='about:'?u.href:u.hostname+u.pathname+(/^#\/[\w/-]{0,40}$/.test(u.hash)?u.hash:'');}catch{}
 return place+(tab.status==='loading'?', still loading':'')+(tab.discarded?', discarded':'');
}
async function claimFetch(connection,path,body) {
 const r=await fetch(connection.origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(path==='/extension/otp'?26000:8000)});
 if(!r.ok)throw Error('Claim bridge HTTP '+r.status);return r.json();
}
async function pollBrowserClaims() {
 if(claimPolling)return;claimPolling=true;
 try {
  const data=await chrome.storage.local.get(CLAIM_STATE),session=await chrome.storage.session.get([CLAIM_JOB,'epicgen.active','epicgen.pending']);
  const c=data[CLAIM_STATE];if(!c||!c.isolateSessions||session['epicgen.active']||session['epicgen.pending'])return;
  if(session[CLAIM_JOB]) {
   const active=session[CLAIM_JOB];
   if(Date.now()-active.startedAt<(active.job.mode==='recover'?RECOVER_STUCK_MS:STUCK_MS))return;
   const tab=await chrome.tabs.get(active.tabId).catch(()=>null);
   await claimFetch(c,'/extension/result',{id:active.job.id,lease:active.job.lease,status:'error',error:'Assigned claim tab made no progress ('+tabPlace(tab)+')'}).catch(()=>{});
   await chrome.storage.session.remove(CLAIM_JOB);return;
  }
  const {job}=await claimFetch(c,'/extension/next');if(!job)return;
  // Remove only Epic's local cookies. Never call Epic's logout endpoint,
  // which can revoke the launcher session that supplied the exchange code.
  if(!c.isolateSessions)throw Error('Reconnect helper with session isolation enabled');
  await chrome.browsingData.removeCookies({origins:['https://www.epicgames.com']});
  const tab=await chrome.tabs.create({url:'about:blank',active:true});
  await chrome.storage.session.set({[CLAIM_JOB]:{job,tabId:tab.id,startedAt:Date.now()}});
  const url=job.mode==='recover'?'https://www.epicgames.com/id/login?lang=en-US':'https://www.epicgames.com/id/exchange?exchangeCode='+encodeURIComponent(job.exchangeCode)+'&redirectUrl='+encodeURIComponent('https://store.epicgames.com/purchase?offers=1-'+job.namespace+'-'+job.offerId);
  await chrome.tabs.update(tab.id,{url});
 }catch{}finally{claimPolling=false;}
}
chrome.alarms.create('epicclaim.poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='epicclaim.poll')pollBrowserClaims();});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
 if(!msg?.type?.startsWith('epicclaim-'))return false;
 (async()=>{
  if(msg.type==='epicclaim-enable') {
   const u=new URL(sender.tab?.url||'');
   if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!['8123','8125'].includes(u.port)||u.pathname!=='/connect'||!/^[a-f\d]{64}$/.test(msg.token||''))throw Error('Invalid local pairing page');
   if(msg.isolateSessions!==true)throw Error('Session isolation consent required');
   const connection={origin:u.origin,token:msg.token,isolateSessions:true};await claimFetch(connection,'/extension/status');
   await chrome.storage.local.set({[CLAIM_STATE]:connection});return {ok:true};
  }
  const {[CLAIM_JOB]:active}=await chrome.storage.session.get(CLAIM_JOB);
  if(!active||active.tabId!==sender.tab?.id)return {ok:false};
  const u=new URL(sender.tab.url);
  if(u.protocol!=='https:'||!['www.epicgames.com','epicgames.com','store.epicgames.com'].includes(u.hostname))return {ok:false};
  if(msg.type==='epicclaim-context')return {ok:true,job:active.job,deadline:active.startedAt+CHECKOUT_MS};
  if(msg.type==='epicclaim-otp'&&active.job.mode==='recover') {
   const {[CLAIM_STATE]:c}=await chrome.storage.local.get(CLAIM_STATE);
   return claimFetch(c,'/extension/otp',{id:active.job.id,lease:active.job.lease});
  }
  if(msg.type==='epicclaim-result') {
   const {[CLAIM_STATE]:c}=await chrome.storage.local.get(CLAIM_STATE);
   // The job is over either way. If the bridge already gave up (HTTP 409),
   // a stale job left here would block the next poll for minutes.
   try{await claimFetch(c,'/extension/result',{id:active.job.id,lease:active.job.lease,status:msg.status,error:msg.error,...(msg.status==='rate_limited'?{retryAfterSeconds:msg.retryAfterSeconds}:{}),...(msg.status==='reauthorized'?{code:msg.code}:{})});}
   finally{await chrome.storage.session.remove(CLAIM_JOB);}
   if(msg.status==='submitted')setTimeout(()=>chrome.tabs.remove(active.tabId).catch(()=>{}),15000);
   else if(['already_owned','reauthorized'].includes(msg.status))await chrome.tabs.remove(active.tabId).catch(()=>{});
   return {ok:true};
  }
  return {ok:false};
 })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
pollBrowserClaims();
// Epic's successful login lands on its account site. Navigation events let us
// request the official authorization code without reading that site's profile.
chrome.tabs.onUpdated.addListener(async(tabId,change)=>{
 if(!change.url)return;
 let u;try{u=new URL(change.url);}catch{return;}
 if(u.origin!=='https://accounts.epicgames.com'||!u.pathname.startsWith('/account'))return;
 const {[CLAIM_JOB]:active}=await chrome.storage.session.get(CLAIM_JOB);
 if(active?.tabId!==tabId||active.job.mode!=='recover')return;
 await chrome.tabs.update(tabId,{url:'https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code'});
});
