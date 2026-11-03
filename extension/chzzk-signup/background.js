// Commands are bound to one private window, one tab and one local signup ID.
const BASE='http://127.0.0.1:4109';let busy=false;
const load=async()=>(await chrome.storage.session.get('active')).active;
const save=async active=>{await chrome.storage.session.set({active});await chrome.storage.local.set({recovery:{id:active.id,tabId:active.tabId,windowId:active.windowId}});};
async function api(s,route,body={}){
  const r=await fetch(BASE+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':s.token},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Local operation failed.');return j;
}
const route=(s,a)=>'/session/'+s.id+'/'+a;
async function stage(s,message){await api(s,route(s,'stage'),{stage:message});}
async function send(s,type,data={}){try{return await chrome.tabs.sendMessage(s.tabId,{type,...data});}catch{throw Error('Wait for the Naver page to finish loading, then Resume.');}}
async function number(s){
  const page=await send(s,'inspect');if(!page.phoneReady)throw Error('Return to the phone-number screen in the same signup first.');
  const r=await api(s,route(s,'number'));s.number=r.result;s.sentAt=null;s.requestedAt=null;s.sendBlockedAt=null;await save(s);
  const filled=await send(s,'number',{number:s.number});if(!filled.ok)throw Error(filled.error);await stage(s,'Phone number filled');
  return r.result;
}
async function replace(s){
  // Keep the popup available until cancellation is confirmed: an SMS can arrive
  // between the timeout poll and 5sim's cancellation response.
  if(!s.replacing){
    try{await api(s,route(s,'replace'));}
    catch(e){const received=await sms(s);if(received.code)return;throw e;}
    s.replacing=true;await save(s);
  }
  const page=await send(s,'inspect');
  if(page.smsPopup){const back=await send(s,'back');if(!back.ok)throw Error('Close the SMS popup before replacing this number.');}
  const p=await send(s,'inspect');
  if(!p.phoneReady){const back=await send(s,'back');if(!back.ok)throw Error('Number cancelled. Go back to the phone-number screen in this window, then Get / fill number.');}
  s.number=null;s.sentAt=null;s.requestedAt=null;s.smsCode=null;s.smsFilled=false;s.replacing=false;await save(s);
  await stage(s,'Changing number in the same signup');
}
async function sms(s){
  const r=await api(s,route(s,'sms'));
  if(r.result.code){s.smsCode=r.result.code;await save(s);const f=await send(s,'sms',{code:s.smsCode});if(f.ok){s.smsFilled=true;await save(s);await stage(s,'SMS code filled');}}
  return r.result;
}
async function capture(s){
  const identity=(await api(s,route(s,'identity'))).identity;
  const page=await send(s,'authenticated',{username:identity.username});
  if(!page.ok)throw Error('Open Naver’s home page in the signup window after creation; it must show the assigned ID and a logout link.');
  const cookies=await cookiesFor(s);
  await api(s,route(s,'events'),{kind:'cookies-meta',page:'https://www.naver.com/',cookies:cookies.map(c=>({name:c.name,domain:c.domain,httpOnly:c.httpOnly,secure:c.secure,session:c.session}))});
  if(!['NID_AUT','NID_SES'].every(n=>cookies.some(c=>c.name===n&&c.value)))throw Error('Naver login cookies are missing. Found: '+cookies.map(c=>c.name).join(', '));
  // The service worker's fetch uses the regular store. Verify inside the assigned
  // private CHZZK tab instead, so a regular-window login cannot be saved by mistake.
  s.captureCookies=cookies;await save(s);
  await chrome.tabs.update(s.tabId,{url:'https://chzzk.naver.com/'});await stage(s,'Verifying CHZZK login');
}
async function cookiesFor(s){
  const tab=await chrome.tabs.get(s.tabId);if(!tab.incognito||tab.windowId!==s.windowId)throw Error('The assigned private tab changed.');
  const stores=await chrome.cookies.getAllCookieStores(),store=stores.find(x=>x.tabIds.includes(s.tabId));
  if(!store)throw Error('Private cookie store unavailable.');
  await api(s,route(s,'events'),{kind:'cookie-store',label:JSON.stringify({tabId:s.tabId,storeId:store.id,incognito:tab.incognito})});
  let cookies=await chrome.cookies.getAll({domain:'naver.com',storeId:store.id});
  if(chrome.cookies.getPartitionKey){const result=await chrome.cookies.getPartitionKey({tabId:s.tabId,frameId:0});if(result.partitionKey)cookies=cookies.concat(await chrome.cookies.getAll({domain:'naver.com',storeId:store.id,partitionKey:result.partitionKey}));}
  const unique=new Map();for(const c of cookies)if(/(^|\.)naver\.com$/i.test(c.domain))unique.set(c.domain+'|'+c.path+'|'+c.name,c);return[...unique.values()];
}
async function tick(s){
  if(s.captureCookies){
    const t=await chrome.tabs.get(s.tabId),url=new URL(t.url);
    if(url.hostname==='nid.naver.com'&&url.pathname==='/nidlogin.login'){
      const page=await send(s,'inspect');if(page.challenge)throw Error('Complete Naver’s sign-in challenge in this window, then Resume.');
      if(!s.loginSubmittedAt){
        const identity=(await api(s,route(s,'identity'))).identity;
        const result=await send(s,'naver-signin',{identity});if(!result.ok)throw Error('Finish Naver sign-in in this window, then Resume.');
        s.loginSubmittedAt=Date.now();await save(s);
      }else if(Date.now()-s.loginSubmittedAt>=15000)throw Error('Check Naver’s sign-in message in this window, then Resume.');
      return;
    }
    if(url.hostname!=='chzzk.naver.com')return;
    const who=await send(s,'chzzk-status');if(!who.ok){
      if(!s.chzzkLoginAt){const result=await send(s,'chzzk-login');if(result.ok){s.chzzkLoginAt=Date.now();await save(s);return;}}
      throw Error('Finish the CHZZK profile setup in this window, then Resume.');
    }
    await api(s,route(s,'sms'));
    await api(s,route(s,'complete'),{cookies:await cookiesFor(s),userIdHash:who.userIdHash,naverId:(await api(s,route(s,'identity'))).identity.username});
    // Account is durable before closing its private window.
    const id=s.windowId;await chrome.storage.session.remove('active');await chrome.windows.remove(id);return;
  }
  if(s.manual)return;
  if(s.replacing){await replace(s);return;}
  const identity=(await api(s,route(s,'identity'))).identity;
  const p=await send(s,'inspect');
  if(p.signupReturn){await chrome.tabs.update(s.tabId,{url:p.signupReturn});return;}
  if(p.createdUsername){await api(s,route(s,'account-name'),{username:p.createdUsername});await chrome.tabs.update(s.tabId,{url:'https://www.naver.com/'});await stage(s,'Naver account created; verifying its login');return;}
  if(p.terms){await stage(s,'Waiting for Naver agreements in the signup window');return;}
  if(p.challenge){await stage(s,'Waiting for the browser challenge');return;}
  if(p.authenticated){await capture(s);return;}
  if(p.phoneReady&&p.phoneEmpty&&s.number&&!p.smsPopup){
    const received=await api(s,route(s,'sms'));
    if(received.result.code)throw Error('This number received SMS before the page restarted. Finish verification in the same signup before replacing it.');
    await number(s);return;
  }
  const fill=await send(s,'identity',{identity});
  if(!s.number&&p.smsPopup){const closed=await send(s,'back');if(!closed.ok)throw Error('Close the old SMS popup, then Resume.');return;}
  if(s.requestedAt&&!s.sentAt&&p.smsPopup){s.sentAt=Date.now();await save(s);await stage(s,'Waiting for SMS (10 seconds)');}
  if(s.requestedAt&&!s.sentAt&&Date.now()-s.requestedAt>=15000)throw Error('Naver did not open the SMS popup. Check its message, then replace the failed number or finish the browser challenge.');
  if(p.phoneReady&&!s.number){await number(s);return;}
  if(s.number&&!s.requestedAt&&p.phoneReady){
    const sent=await send(s,'send-sms');
    if(sent.ok){s.requestedAt=Date.now();s.sendBlockedAt=null;await save(s);await stage(s,'Waiting for Naver to accept the SMS request');}
    else if(p.phoneRejected){
      if(!s.sendBlockedAt){s.sendBlockedAt=Date.now();await save(s);}
      else if(Date.now()-s.sendBlockedAt>=5000){await stage(s,'Naver rejected the phone number; changing country');await replace(s);}
    }
    return;
  }
  if(s.sentAt&&!s.smsCode){
    const r=await sms(s);if(r.code)return;
    if(['TIMEOUT','CANCELED','BANNED'].includes(r.status)||Date.now()-s.sentAt>=10000){await replace(s);return;}
  }
  if(s.smsCode&&!s.smsFilled)await sms(s);
  if(fill.ready)await send(s,'advance');
}
async function handle(m,sender){
  const local=sender.tab?.url===BASE+'/';
  if(m.type==='log-event'){
    const s=await load();if(!s||sender.tab?.id!==s.tabId||sender.tab?.windowId!==s.windowId||!sender.tab.incognito)return{ok:false};
    await api(s,route(s,'events'),m.event||{});return{ok:true};
  }
  if(m.type==='tick'){
    const s=await load();if(!s||sender.tab?.id!==s.tabId||sender.tab?.windowId!==s.windowId||!sender.tab.incognito)return{ok:false};
    if(s.paused)return{ok:true};
    await tick(s);return{ok:true};
  }
  if(!local||typeof m.token!=='string')return{ok:false,error:'Open the local CHZZK generator.'};
  if(m.type==='connect'){
    if(!await chrome.extension.isAllowedIncognitoAccess())throw Error('Enable Allow in Incognito for the CHZZK extension.');
    return{ok:true,version:chrome.runtime.getManifest().version};
  }
  if(m.type==='open'||m.type==='resume'){
    let s=await load();if(s&&s.id!==m.sessionId)throw Error('Close the previous signup before opening another.');
    if(s){try{await chrome.tabs.get(s.tabId);}catch{s=null;}}
    if(!s){
      const privateWindows=(await chrome.windows.getAll({populate:true})).filter(w=>w.incognito);
      if(m.type==='resume'&&privateWindows.length===1){
        const w=privateWindows[0],tabs=w.tabs||[];
        const recovery=(await chrome.storage.local.get('recovery')).recovery;
        const t=tabs.length===1&&tabs[0],url=t&&new URL(t.url);
        const known=recovery?.id===m.sessionId&&recovery.tabId===t?.id;
        const signup=url?.hostname==='nid.naver.com'&&url.pathname.startsWith('/account/signup/');
        if(t&&(known||signup))s={id:m.sessionId,token:m.token,tabId:t.id,windowId:w.id};
      }
      if(!s&&privateWindows.length)throw Error('Close unrelated private windows before starting CHZZK signup.');
    }
    if(!s){
      s={id:m.sessionId,token:m.token};await api(s,route(s,'identity'));
      const w=await chrome.windows.create({incognito:true,url:'https://nid.naver.com/account/signup/term?lang=en_US&realname=N'});
      s.windowId=w.id;s.tabId=w.tabs[0].id;
    }
    s.token=m.token;s.paused=false;s.manual=(await api(s,route(s,'identity'))).identity.manual===true;await save(s);await chrome.windows.update(s.windowId,{focused:true});return{ok:true};
  }
  const s=await load();if(!s)throw Error('Resume the signup window first.');
  if(m.sessionId&&s.id!==m.sessionId)throw Error('Wrong signup.');s.token=m.token;
  if(m.type==='number')await number(s);
  else if(m.type==='sms')await sms(s);
  else if(m.type==='replace')await replace(s);
  else if(m.type==='save')await capture(s);
  else if(m.type==='close'){await chrome.storage.session.remove('active');await chrome.windows.remove(s.windowId);}
  else throw Error('Unknown command');
  return{ok:true};
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.type==='log-event'){handle(m,sender).then(reply).catch(()=>reply({ok:false}));return true;}
  if(busy){reply({ok:false,error:'Signup operation is running.'});return;}
  busy=true;handle(m,sender).then(reply).catch(async e=>{
    const s=await load();if(s&&m.type==='tick'){s.paused=true;await save(s);await stage(s,'Paused — '+(e.message||'resume signup')).catch(()=>{});}
    reply({ok:false,error:e.message||'Signup operation failed.'});
  }).finally(()=>{busy=false;});return true;
});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:BASE+'/'}));
