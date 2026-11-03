(() => {
  const $=id=>document.getElementById(id);let state,editing=null,secretTimer;
  const stageNames={signup_pending:'Signup pending',stock:'Stock',listing:'Publishing',listed:'On Eldorado',sold:'Sold',problem:'Needs attention'};
  const date=value=>value?new Date(value).toLocaleString():'Unverified';
  const text=(tag,value,className='')=>{const el=document.createElement(tag);el.textContent=value;el.className=className;return el;};
  async function api(url,body,method='POST') {
    const response=await fetch(url,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json','Accept':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401){location.href='/admin-login.html?next='+encodeURIComponent(location.pathname);throw Error('Sign in required');}
    let data;try{data=await response.json();}catch{throw Error('The server could not return account data');}
    if(!response.ok||!data.success)throw Error(data.message||'Request failed');return data;
  }
  function clearSecrets(){document.querySelectorAll('.secret').forEach(el=>el.remove());clearTimeout(secretTimer);}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearSecrets();});
  function renderMarket(){
    const root=$('market');root.replaceChildren();const p=state.permission;
    root.append(text('p',p.canSell===false?'Eldorado has not enabled Valorant account sales for this seller.':p.canSell===true?'Valorant account category access is enabled.':'Category access has not been verified.',p.canSell===true?'good':'warning'));
    if(p.checkedAt)root.append(text('p','Last checked '+date(p.checkedAt),'muted'));
    if(p.error)root.append(text('p',p.error,'warning'));
    root.append(text('p',state.summary.listed?`${state.summary.listed} account(s) on sale.`:'No Valorant accounts are on sale yet.'));
  }
  function renderAccounts(){
    const root=$('accounts');if(root.querySelector('.secret'))return;root.replaceChildren();
    const query=$('search').value.trim().toLowerCase(),stage=$('stage').value;
    const rows=state.accounts.filter(a=>(!stage||a.stage===stage)&&[a.accountName,a.riotId,a.country,a.shard,a.requestedCountry].some(v=>String(v||'').toLowerCase().includes(query)));
    if(!rows.length){root.append(text('p',state.accounts.length?'No accounts match this filter.':'No signup records have been uploaded yet.','empty'));return;}
    const list=text('div','','account-list');
    for(const a of rows){
      const row=text('article','','account'),identity=text('div','');identity.append(text('strong',a.accountName),text('small',a.riotId||'Riot ID unverified'),text('small','Created '+(a.signedUpAt?date(a.signedUpAt):'— signup unfinished')));row.append(identity);
      const region=text('div','');region.append(text('span',a.shard?`${a.shard} · ${a.country}`:`Expected ${a.expectedShard||'unknown'} · ${a.requestedCountry||'unknown'}`,'pill'),text('small',a.regionCheckedAt?'Region checked '+date(a.regionCheckedAt):'Game region unverified'),text('small','Proxy country '+(a.proxyCountry||'unknown')));row.append(region);
      const game=text('div','');game.append(text('span',a.level===null||a.level===undefined?'Level unverified':'Level '+a.level),text('small',a.rank||'Rank unverified'),text('small',`${a.skinCount??'?'} skins · ${a.agentCount??'?'} agents`));row.append(game);
      const status=text('div','');status.append(text('span',stageNames[a.stage]||a.stage,'pill'),text('small',a.blockers.join(' · ')||'Account checks complete',a.blockers.length?'warning':'good'));
      if(a.listingUrl){try{const u=new URL(a.listingUrl);if(u.protocol==='https:'&&u.hostname==='www.eldorado.gg'){const link=text('a','View listing');link.href=u.href;link.target='_blank';link.rel='noopener';status.append(link);}}catch{}}
      row.append(status);const actions=text('div','','actions'),details=text('button','Details'),reveal=text('button','Reveal');
      details.onclick=()=>openDetails(a);reveal.onclick=async()=>{try{clearSecrets();const d=await api('/api/valorant/accounts/'+a._id+'/credentials');const pre=text('pre',`${a.stage==='signup_pending'?'Reserved identity — signup unfinished\n\n':''}Login: ${d.accountName}\nPassword: ${d.password}\nEmail: ${d.email}\nBirth date: ${d.birthDate}`,'secret');row.append(pre);secretTimer=setTimeout(clearSecrets,60000);}catch(e){$('message').textContent=e.message;}};
      actions.append(details,reveal);row.append(actions);list.append(row);
    }root.append(list);
  }
  function render(){
    const summary=$('summary');summary.replaceChildren();
    for(const [name,value] of [['Completed',state.summary.completed],['Signup pending',state.summary.pending],['Verified regions',state.summary.regions],['Checks complete',state.summary.ready],['Listed',state.summary.listed],['Sold',state.summary.sold]]){const box=text('div','','stat');box.append(text('strong',value),text('span',name));summary.append(box);}
    const regions=$('regions');regions.replaceChildren();for(const shard of ['AP','NA','EU','LATAM','BR']){
      const rows=state.accounts.filter(a=>(a.shard||a.expectedShard)===shard),box=text('div','','region');
      box.append(text('b',shard),text('small',`${rows.filter(a=>a.regionCheckedAt).length} region verified`),text('small',`${rows.filter(a=>a.stage==='signup_pending').length} signup pending · ${rows.filter(a=>a.stage==='stock').length} stock`));regions.append(box);
    }renderAccounts();renderMarket();
  }
  function openDetails(a){
    editing=a;const form=$('edit');form.reset();$('detailsTitle').textContent=a.accountName;$('detailStatus').textContent=stageNames[a.stage]+' · '+a.blockers.join(' · ');$('editMessage').textContent='';
    for(const key of ['riotId','rank','level','skinCount','agentCount','notes'])form.elements[key].value=a[key]??'';
    form.elements.country.value=a.country||'';form.elements.shard.value=a.shard||'';form.elements.evidence.value=a.regionEvidence||'';
    form.elements.emailVerified.checked=!!a.emailVerified;form.elements.loginVerified.checked=!!a.loginVerifiedAt;
    const locked=['listing','listed','sold'].includes(a.stage);$('checks').disabled=locked||a.stage==='signup_pending';$('save').disabled=locked;
    $('details').showModal();
  }
  $('edit').onsubmit=async event=>{
    event.preventDefault();const f=event.currentTarget.elements,body={};
    for(const key of ['riotId','rank','notes'])body[key]=f[key].value;
    for(const key of ['level','skinCount','agentCount'])body[key]=f[key].value===''?null:Number(f[key].value);
    if(editing.stage!=='signup_pending'){body.emailVerified=f.emailVerified.checked;body.loginVerified=f.loginVerified.checked;
      if(f.regionChecked.checked)body.regionCheck={country:f.country.value.trim().toUpperCase(),shard:f.shard.value,evidence:f.evidence.value.trim()};}
    try{$('save').disabled=true;await api('/api/valorant/accounts/'+editing._id,body,'PATCH');$('details').close();await load();}
    catch(e){$('editMessage').textContent=e.message;}finally{$('save').disabled=false;}
  };
  $('close').onclick=()=>$('details').close();
  async function load(){try{state=await api('/api/valorant/accounts');render();}catch(e){$('message').textContent=e.message;}}
  $('refresh').onclick=()=>{clearSecrets();load();};$('search').oninput=renderAccounts;$('stage').onchange=renderAccounts;
  $('permission').onclick=async()=>{const b=$('permission');b.disabled=true;try{const d=await api('/api/valorant/eldorado/check',{});state.permission=d.permission;renderMarket();}catch(e){$('message').textContent=e.message;}finally{b.disabled=false;}};
  load();
})();
