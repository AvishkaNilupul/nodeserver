(()=>{
 const $=id=>document.getElementById(id),token=document.querySelector('meta[name="epic-local-token"]').content;
 let revealTimer;
 async function api(url,method='GET'){
  const r=await fetch(url,{method,cache:'no-store',headers:{'X-Local-Token':token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});const data=await r.json();if(!r.ok||!data.success)throw Error(data.message||'Local request failed');return data;
 }
 function hide(){$('localSecretText').textContent='';$('localCredentials').hidden=true;clearTimeout(revealTimer);}
 async function reveal(id){
  hide();try{const a=await api('/api/local/accounts/'+encodeURIComponent(id)+'/reveal','POST');const p=a.profile||{};
   $('localSecretText').textContent=[['Display name',a.displayName],['Email',a.email],['Epic password',a.password],['2FA key',a.totpSecret],['First name',p.firstName],['Last name',p.lastName],['Date of birth',p.dateOfBirth],['Country',p.country]].filter(([,v])=>v).map(([k,v])=>k+': '+v).join('\n');
   $('localCredentials').hidden=false;revealTimer=setTimeout(hide,60000);
  }catch(e){$('signupStatus').textContent=e.message;}
 }
 async function load(){
  try{const data=await api('/api/local/accounts');$('localAccounts').replaceChildren();if(!data.accounts.length){$('localAccounts').textContent='No local accounts saved yet.';return;}
   const table=document.createElement('table'),head=document.createElement('tr');for(const title of ['Account','Email','Saved','Details']){const cell=document.createElement('th');cell.textContent=title;head.append(cell);}table.append(head);
   for(const a of data.accounts){const tr=document.createElement('tr');for(const value of [a.displayName||a.accountId,a.email,new Date(a.createdAt).toLocaleString()]){const td=document.createElement('td');td.textContent=value||'—';tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='Show details';button.addEventListener('click',()=>reveal(a._id));td.append(button);tr.append(td);table.append(tr);}$('localAccounts').append(table);
  }catch(e){$('localAccounts').textContent=e.message;}
 }
 $('localExtensionCheck').addEventListener('click',()=>{
  $('signupStatus').textContent='Checking Chrome extension…';
  const listener=event=>{if(event.source!==window||event.origin!==location.origin||event.data?.type!=='epicgen-ping-ack')return;clearTimeout(timer);window.removeEventListener('message',listener);$('signupStatus').textContent=event.data.ok?'Extension connected. Ready to create a local signup.':'Extension is unavailable.';};
  const timer=setTimeout(()=>{window.removeEventListener('message',listener);$('signupStatus').textContent='Extension did not respond. Use Chrome with Marketplace Filler 1.3.0 enabled and refresh this local page.';},3000);
  window.addEventListener('message',listener);window.postMessage({type:'epicgen-ping'},location.origin);
 });
 window.load=load;$('localRefresh').addEventListener('click',load);$('localHide').addEventListener('click',hide);
 $('localCopy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('localSecretText').textContent);$('signupStatus').textContent='Local login details copied.';}catch{$('signupStatus').textContent='Clipboard unavailable. Select the revealed details to copy.';}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();});
 api('/api/local/status').then(s=>{$('localStatus').textContent='Encrypted local vault ready · Outlook reader '+(s.mailReady?'connected':'unavailable on port 3999')+' · Proxy '+(s.proxyReady?'configured':'not configured');}).catch(e=>{$('localStatus').textContent=e.message;});load();
})();
