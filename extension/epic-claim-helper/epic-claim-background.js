// Jobs are authenticated locally, assigned to exactly one tab, and run serially.
const CLAIM_STATE='epicclaim.connection',CLAIM_JOB='epicclaim.job';
let claimPolling=false;
async function claimFetch(connection,path,body) {
 const r=await fetch(connection.origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('Claim bridge HTTP '+r.status);return r.json();
}
async function pollBrowserClaims() {
 if(claimPolling)return;claimPolling=true;
 try {
  const data=await chrome.storage.local.get(CLAIM_STATE),session=await chrome.storage.session.get([CLAIM_JOB,'epicgen.active','epicgen.pending']);
  const c=data[CLAIM_STATE];if(!c||session['epicgen.active']||session['epicgen.pending'])return;
  if(session[CLAIM_JOB]) {
   const active=session[CLAIM_JOB];
   if(Date.now()-active.startedAt<140000)return;
   await claimFetch(c,'/extension/result',{...active.job,status:'error',error:'Assigned claim tab timed out'}).catch(()=>{});
   await chrome.storage.session.remove(CLAIM_JOB);return;
  }
  const {job}=await claimFetch(c,'/extension/next');if(!job)return;
  const tab=await chrome.tabs.create({url:'about:blank',active:true});
  await chrome.storage.session.set({[CLAIM_JOB]:{job,tabId:tab.id,startedAt:Date.now()}});
  const url='https://www.epicgames.com/id/exchange?exchangeCode='+encodeURIComponent(job.exchangeCode)+'&redirectUrl='+encodeURIComponent('https://store.epicgames.com/purchase?offers=1-'+job.namespace+'-'+job.offerId);
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
   const connection={origin:u.origin,token:msg.token};await claimFetch(connection,'/extension/status');
   await chrome.storage.local.set({[CLAIM_STATE]:connection});return {ok:true};
  }
  const {[CLAIM_JOB]:active}=await chrome.storage.session.get(CLAIM_JOB);
  if(!active||active.tabId!==sender.tab?.id)return {ok:false};
  const u=new URL(sender.tab.url);
  if(u.protocol!=='https:'||!['www.epicgames.com','epicgames.com','store.epicgames.com'].includes(u.hostname))return {ok:false};
  if(msg.type==='epicclaim-context')return {ok:true,job:active.job};
  if(msg.type==='epicclaim-result') {
   const {[CLAIM_STATE]:c}=await chrome.storage.local.get(CLAIM_STATE);
   await claimFetch(c,'/extension/result',{id:active.job.id,lease:active.job.lease,status:msg.status,error:msg.error});
   await chrome.storage.session.remove(CLAIM_JOB);
   if(['submitted','already_owned'].includes(msg.status))await chrome.tabs.remove(active.tabId).catch(()=>{});
   return {ok:true};
  }
  return {ok:false};
 })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
pollBrowserClaims();
