const token=document.querySelector('meta[name="local-token"]').content;
const $=id=>document.getElementById(id);
let connected=false,connecting=false,current,catalog,queue=null,loading=false,launching=false,secretTimer;
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Local-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.status===403)throw Error('The local generator restarted. Reload this page to reconnect.');let data;try{data=await r.json();}catch{throw Error('The local generator did not return a usable response.');}if(!r.ok||!data.ok)throw Error(data.error||'Local request failed ('+r.status+')');return data;}
function extension(type,options={}){return new Promise((resolve,reject)=>{
 const id=crypto.randomUUID();const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('Steam extension did not respond. Check its permissions and reload this page.'));},type==='start'||type==='resume'?35000:6000);
 function receive(e){if(e.source===window&&e.origin===location.origin&&e.data?.channel==='steam-local-response'&&e.data.id===id){clearTimeout(timer);window.removeEventListener('message',receive);e.data.result?.ok?resolve(e.data.result):reject(Error(e.data.result?.error||'Extension request failed'));}}
 window.addEventListener('message',receive);window.postMessage({channel:'steam-local-request',id,type,token:type==='connect'?token:undefined,...options},location.origin);
});}
function clearSecrets(){document.querySelectorAll('[data-secret]').forEach(e=>e.remove());clearTimeout(secretTimer);}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearSecrets();});
function controls(){
 const ready=connected&&!launching&&!current?.active&&!queue&&current?.pool.exclusiveReady;
 $('start').disabled=!ready;$('queue').disabled=!ready;$('resume').disabled=!connected||launching||!current?.active||!!queue;$('stop').disabled=!queue;
 $('perCountry').disabled=launching||!!queue;$('country').disabled=launching||!!queue;$('sample').disabled=launching||!!queue;
}
function queueText(){ $('queueStatus').textContent=queue?`Regional queue · ${queue.done} finished · ${queue.remaining.length} waiting${queue.current?' · current: '+queue.current:''}`:'No queue running.';controls();}
function stop(reason){queue=null;queueText();if(reason)$('message').textContent=reason;}
// Upload state for the server's Steam accounts page (docs/STEAM-ACCOUNTS.md).
function serverCell(a){
 const td=document.createElement('td'),c=a.cloud;
 td.textContent=!current.cloudEnabled?'Not set up':!c?'Not queued':c.state==='uploaded'?'On server':c.state==='uploading'?'Uploading…':c.lastError?'Waiting to retry':'Queued';
 if(current.cloudEnabled&&c?.state!=='uploaded'&&c?.state!=='uploading'){const b=document.createElement('button');b.textContent='Retry';b.title=c?.lastError||'Send to the server now';b.onclick=async()=>{try{b.disabled=true;await api('/api/cloud/retry',{});await load();}catch(e){$('message').textContent=e.message;b.disabled=false;}};td.append(document.createElement('br'),b);}
 return td;
}
function accountTable(){
 const root=$('accounts');if(root.querySelector('[data-secret]'))return;root.replaceChildren();
 if(!current.accounts.length){root.textContent='No saved Steam accounts yet.';return;}
 const table=document.createElement('table'),head=document.createElement('tr');
 for(const label of ['Account name','Email','Signup / proxy','Store country','Status','Server','']){const th=document.createElement('th');th.textContent=label;head.append(th);}table.append(head);
 for(const a of current.accounts){const tr=document.createElement('tr');
  for(const value of [a.username,a.email,(a.country||'Unknown')+' / '+(a.creationLocation?.country||'Not recorded')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  const countryCell=document.createElement('td'),check=document.createElement('button');
  countryCell.append(document.createTextNode(a.storeCountry?`${new Intl.DisplayNames(['en'],{type:'region'}).of(a.storeCountry)} (${a.storeCountry})`:'Unverified'));
  if(a.storeCountryCheckedAt){const time=document.createElement('small');time.textContent='Checked '+new Date(a.storeCountryCheckedAt).toLocaleString();countryCell.append(document.createElement('br'),time);}
  check.textContent=a.storeCountryCheck?.state==='checking'?'Checking…':a.storeCountry?'Recheck store country':'Check store country';
  check.disabled=current.accounts.some(x=>x.storeCountryCheck?.state==='checking');
  check.onclick=async()=>{try{check.disabled=true;await api('/api/accounts/'+encodeURIComponent(a.id)+'/store-country',{});await load();}catch(e){$('message').textContent=e.message;check.disabled=false;}};
  countryCell.append(document.createElement('br'),check);
  if(a.storeCountryCheck?.state==='error'){const error=document.createElement('small');error.textContent=a.storeCountryCheck.message;countryCell.append(document.createElement('br'),error);}
  tr.append(countryCell);
  const statusCell=document.createElement('td');statusCell.textContent=a.mailPending?'Saved · mail sync pending':a.status;tr.append(statusCell);
  tr.append(serverCell(a));
  const td=document.createElement('td'),reveal=document.createElement('button');reveal.textContent='Reveal';
  reveal.onclick=async()=>{try{clearSecrets();const v=await api('/api/accounts/'+encodeURIComponent(a.id)+'/reveal',{});const p=document.createElement('pre');p.dataset.secret='true';p.textContent=`${v.username}\n${v.email}\n${v.password}`+(v.contact?`\n\nSample contact (${v.contact.country})\n${v.contact.phone}\n${v.contact.address}\nCannot receive SMS`:'');td.append(p);secretTimer=setTimeout(clearSecrets,60000);}catch(e){$('message').textContent=e.message;}};
  td.append(reveal);
  if(!a.contact){const b=document.createElement('button');b.textContent='Save sample contact';b.onclick=async()=>{try{b.disabled=true;await api('/api/accounts/'+encodeURIComponent(a.id)+'/contact',{});await load();}catch(e){$('message').textContent=e.message;b.disabled=false;}};td.append(b);}
  tr.append(td);table.append(tr);
 }root.append(table);
}
async function launch(type,country=$('country').value,sample=$('sample').checked){
 launching=true;controls();try{await extension(type,{country,sampleContact:sample,autoSubmit:true});$('message').textContent='Checking the private browser proxy, then starting automatic signup. Only solve a CAPTCHA if a challenge appears.';}finally{launching=false;controls();}
}
async function advanceQueue(){
 if(!queue||launching)return;
 if(queue.current){
  const status=await extension('status');if(status.lastError){stop(status.lastError);return;}
  if(status.busy||current.active)return;
  if(current.accounts.length<=queue.accountCount)return;
  queue.done++;queue.current=null;
 }
 if(!queue.remaining.length){const n=queue.done;stop(`Regional queue finished · ${n} account(s) saved.`);return;}
 const country=queue.remaining.shift();queue.current=country;queue.accountCount=current.accounts.length;queueText();
 try{await launch('start',country,queue.sample);}catch(e){stop(e.message);}
}
async function load(){
 if(loading)return;loading=true;
 try{current=await api('/api/state');if(connected){try{const status=await extension('status');$('extensionStatus').textContent=status.lastError?'Signup stopped: '+status.lastError:status.busy?'Signup is running in a private window.':'No private signup window is active.';}catch(e){$('extensionStatus').textContent=e.message;}}$('connection').textContent=current.pool.error||(!current.pool.exclusiveReady?"Cloud Outlook disconnected; reconnect the cloud mail tunnel":`Cloud Outlook connected · ${current.pool.inboxes} inboxes · ${current.pool.steamUsed} used for Steam · ${current.pool.unused??'?'} unused`);
 $('active').textContent=current.active?`Interrupted signup: ${current.active.email} · ${current.active.username} · ${current.active.requestedCountry||current.active.country||'unknown region'}`:'';accountTable();controls();await advanceQueue();queueText();
 }catch(e){$('message').textContent=e.message;if(queue)stop(e.message);}finally{loading=false;}
}
async function loadRegions(){catalog=await api('/api/regions');const passed=new Set(catalog.report.results.filter(r=>r.matched).map(r=>r.requested));
 for(const id of ['country','regions']){$(id).replaceChildren();for(const c of catalog.countries){const o=document.createElement('option');o.value=c.code;o.textContent=`${c.name} (${c.code})${passed.has(c.code)?' · tested':' · test before use'}`;o.selected=id==='country'&&c.code==='JP';$(id).append(o);}}
 $('proxyResult').textContent=`${catalog.countries.length} published country targets · ${passed.size} tested successfully. Every signup checks the current exit again.`;
}
$('test').onclick=async()=>{const b=$('test');b.disabled=true;$('proxyResult').textContent='Testing selected proxy…';try{const r=await api('/api/proxy/prepare',{country:$('country').value});$('proxyResult').textContent=`Verified ${r.proxy.location.country} · ${r.proxy.location.city||r.proxy.location.region||'location confirmed'} · no inbox reserved`;}catch(e){$('proxyResult').textContent=e.message;}finally{b.disabled=false;}};
async function connect(){if(connected||connecting)return;connecting=true;try{const r=await extension('connect');if(r.version!=='0.3.0')throw Error('Reload the updated Steam Signup extension first');connected=true;$('extension').textContent='Steam Signup extension connected · '+r.version;await load();}catch(e){$('extension').textContent=e.message;}finally{connecting=false;}}
$('connect').onclick=connect;
for(const action of ['start','resume'])$(action).onclick=async()=>{try{await launch(action);}catch(e){$('message').textContent=e.message;}finally{await load();}};
$('tested').onclick=()=>{const passed=new Set(catalog.report.results.filter(r=>r.matched).map(r=>r.requested));for(const o of $('regions').options)o.selected=passed.has(o.value);};
$('all').onclick=()=>{for(const o of $('regions').options)o.selected=true;};
$('queue').onclick=async()=>{const repeats=Number($('perCountry').value);if(!Number.isInteger(repeats)||repeats<1||repeats>10){$('message').textContent='Choose 1 to 10 accounts per country.';return;}const remaining=Array.from($('regions').selectedOptions).flatMap(o=>Array(repeats).fill(o.value));if(!remaining.length){$('message').textContent='Select countries for the queue first.';return;}if(remaining.length>(current.pool.unused??0)){$('message').textContent='Not enough completely unused Outlook inboxes for the selected countries.';return;}queue={remaining,sample:$('sample').checked,done:0,current:null,accountCount:current.accounts.length};queueText();await load();};
$('stop').onclick=()=>{if(queue){queue.remaining=[];$('message').textContent='The queue will stop after the current signup.';queueText();}};
loadRegions().catch(e=>$('message').textContent=e.message);load();connect();setInterval(load,6000);setInterval(()=>{if(!connected)connect();},10000);
