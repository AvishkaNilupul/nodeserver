(()=>{
 const $=id=>document.getElementById(id),token=document.querySelector('meta[name="epic-local-token"]').content;
 let revealTimer;
 async function api(url,method='GET'){
  const r=await fetch(url,{method,cache:'no-store',headers:{'X-Local-Token':token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});const data=await r.json();if(!r.ok||!data.success)throw Error(data.message||'Local request failed');return data;
 }
 function hide(){$('localSecretText').textContent='';$('localCredentials').hidden=true;clearTimeout(revealTimer);}
 async function reveal(id){
  hide();try{const a=await api('/api/local/accounts/'+encodeURIComponent(id)+'/reveal','POST');const p=a.profile||{};
   $('localSecretText').textContent=[['Display name',a.displayName],['Email',a.email],['Epic password',a.password],['2FA key',a.totpSecret],['First name',p.firstName],['Last name',p.lastName],['Date of birth',p.dateOfBirth],['Epic country',p.country],['Creation country',p.creationCountry],['Country source',p.creationCountrySource],['Creation IP',p.creationIp],['Sample phone (internal)',p.contactSource==='synthetic-internal'?p.phone:''],['Sample address (internal)',p.contactSource==='synthetic-internal'?p.address:'']].filter(([,v])=>v).map(([k,v])=>k+': '+v).join('\n');
   $('localCredentials').hidden=false;revealTimer=setTimeout(hide,60000);
  }catch(e){$('signupStatus').textContent=e.message;}
 }
 async function load(){
  try{const [data,recent]=await Promise.all([api('/api/local/accounts'),api('/api/epic/signup/recent')]);
   const select=$('signupSession');if(select&&document.activeElement!==select){const chosen=select.value;select.replaceChildren();const latest=document.createElement('option');latest.value='';latest.textContent='Latest interrupted signup';select.append(latest);for(const s of recent.sessions||[]){if(s.status==='verified')continue;const option=document.createElement('option');option.value=s.sessionId;option.textContent=s.email+' — '+s.status.replace(/_/g,' ');select.append(option);}select.value=chosen;if(select.selectedIndex<0)select.value='';}
   $('localAccounts').replaceChildren();if(!data.accounts.length){$('localAccounts').textContent='No local accounts saved yet.';return;}
   const table=document.createElement('table'),head=document.createElement('tr');for(const title of ['Account','Email','Creation country','Saved','Cloud','Details']){const cell=document.createElement('th');cell.textContent=title;head.append(cell);}table.append(head);
   for(const a of data.accounts){const tr=document.createElement('tr');for(const value of [a.displayName||a.accountId,a.email,(a.profile?.creationCountry||a.profile?.country||'Unknown')+(a.profile?.creationCountrySource==='proxy-ip'?' (IP checked)':' (recorded country; IP unknown)'),new Date(a.createdAt).toLocaleString()]){const td=document.createElement('td');td.textContent=value||'—';tr.append(td);}const cloudCell=document.createElement('td');cloudCell.textContent=a.cloud?.state==='uploaded'?'Uploaded':a.cloud?.state==='uploading'?'Uploading…':a.cloud?.state==='pending'?'Queued for upload':'Not queued';if(a.cloud?.state==='uploaded'&&a.cloud.cloudId){const link=document.createElement('a');link.textContent='Uploaded';link.href='https://redeemhub.lets.game/epic-accounts.html#details?account='+encodeURIComponent(a.cloud.cloudId);link.target='_blank';link.rel='noopener';cloudCell.replaceChildren(link);}if(a.cloud?.lastError){const note=document.createElement('small');note.textContent=a.cloud.lastError;cloudCell.append(note);}tr.append(cloudCell);const td=document.createElement('td'),button=document.createElement('button');button.textContent='Show details';button.addEventListener('click',()=>reveal(a._id));td.append(button);tr.append(td);table.append(tr);}$('localAccounts').append(table);
  }catch(e){$('localAccounts').textContent=e.message;}
 }
 $('localExtensionCheck').addEventListener('click',()=>{
  $('signupStatus').textContent='Checking Chrome extension…';
  const listener=event=>{if(event.source!==window||event.origin!==location.origin||event.data?.type!=='epicgen-ping-ack')return;clearTimeout(timer);window.removeEventListener('message',listener);$('signupStatus').textContent=event.data.ok?'Extension connected. Ready to create a local signup.':'Extension is unavailable.';};
  const timer=setTimeout(()=>{window.removeEventListener('message',listener);$('signupStatus').textContent='Extension did not respond. Use Chrome with Marketplace Filler 1.5.0 enabled and refresh this local page.';},3000);
  window.addEventListener('message',listener);window.postMessage({type:'epicgen-ping'},location.origin);
 });
 $('localCloudRetry').addEventListener('click',async()=>{try{await api('/api/local/cloud/retry','POST');$('signupStatus').textContent='Pending cloud uploads queued for retry.';load();}catch(e){$('signupStatus').textContent=e.message;}});
 setInterval(()=>{if(!document.hidden&&$('localCredentials').hidden)load();},15000);
 window.load=load;$('localRefresh').addEventListener('click',load);$('localHide').addEventListener('click',hide);
 $('localCopy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('localSecretText').textContent);$('signupStatus').textContent='Local login details copied.';}catch{$('signupStatus').textContent='Clipboard unavailable. Select the revealed details to copy.';}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();});
 api('/api/local/status').then(s=>{$('localStatus').textContent='Encrypted local vault ready · Outlook reader '+(s.mailReady?'connected':'unavailable on port 3999')+' · Proxy '+(s.proxyReady?'configured':'not configured')+' · Cloud upload '+(s.cloudEnabled?'enabled':'disabled');}).catch(e=>{$('localStatus').textContent=e.message;});load();
})();
