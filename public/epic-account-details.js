/* Account records share Epic's existing claim inventory and sold state. */
(() => {
  function init() {
    const main = document.querySelector('main');
    if (!main) return;
    const claimPanel = document.createElement('section');
    claimPanel.id = 'epic-claims-panel';
    claimPanel.setAttribute('role', 'tabpanel');
    [...main.querySelectorAll(':scope > .card')].forEach(card => claimPanel.append(card));
    const tabs = document.createElement('div');
    tabs.className = 'epic-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label','Epic accounts');
    tabs.innerHTML = '<button class="btn" id="epic-claims-tab" role="tab" aria-controls="epic-claims-panel">Claims</button><button class="btn" id="epic-details-tab" role="tab" aria-controls="epic-details-panel">Account details</button>';
    main.append(tabs, claimPanel);
    const panel = document.createElement('section');
    panel.id = 'epic-details-panel'; panel.setAttribute('role','tabpanel'); panel.hidden = true;
    panel.innerHTML = `
      <div class="card">
        <h2>Account details</h2><p class="hint">Keep sign-in and recovery details with each account for sale preparation. Editing this record does not change the Epic login.</p>
        <div class="row"><label for="epic-detail-account">Account</label><select id="epic-detail-account"><option value="">Choose an account</option></select><button type="button" class="btn" id="epic-detail-refresh">Refresh accounts</button></div>
        <p id="epic-detail-status" class="hint" role="status"></p>
      </div>
      <form id="epic-detail-form" class="card" hidden autocomplete="off">
        <h2 id="epic-detail-name"></h2><p class="hint" id="epic-detail-summary"></p>
        <div class="epic-detail-grid">
          <label>Stock label<input name="label" maxlength="160" /></label>
          <label>Stored sign-in email<input name="email" type="email" maxlength="254" autocomplete="off" /></label>
          <label>First name<input name="firstName" maxlength="80" /></label>
          <label>Last name<input name="lastName" maxlength="80" /></label>
          <label>Date of birth<input name="dateOfBirth" type="date" min="1900-01-01" /></label>
          <label>Country code<input name="country" maxlength="2" placeholder="e.g. CO" /></label>
          <label>Epic password<input name="password" type="password" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep saved password" /></label>
          <label>2FA setup key<input name="totpSecret" type="password" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep saved key" /></label>
        </div>
        <label class="epic-detail-notes">Internal notes<textarea name="notes" maxlength="4000" rows="4"></textarea></label>
        <div class="row"><button class="btn btn-primary" id="epic-detail-save" type="submit">Save details</button><button type="button" class="btn" id="epic-detail-reveal">Show saved credentials</button><button type="button" class="btn" id="epic-detail-copy">Copy sale details</button></div>
        <div id="epic-detail-secrets" class="epic-detail-grid" hidden>
          <label>Saved Epic password<input id="epic-detail-saved-password" type="text" readonly autocomplete="off" /></label>
          <label>Saved 2FA setup key<input id="epic-detail-saved-totp" type="text" readonly autocomplete="off" /></label>
        </div>
        <p class="hint">Copied sale details include saved login details, name, date of birth, country and owned games. Internal notes and sign-in tokens are excluded.</p>
        <h2>Owned games</h2><ul id="epic-detail-games"></ul>
      </form>`;
    main.append(panel);
    const $ = id => document.getElementById(id);
    const form = $('epic-detail-form'), select = $('epic-detail-account');
    let selected = null, dirty = false, hideTimer, requestVersion = 0;
    const status = (text, error=false) => { $('epic-detail-status').textContent=text; $('epic-detail-status').style.color=error?'var(--red)':''; };
    async function request(path, opts={}) {
      const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});
      const data=await r.json(); if(!r.ok||data.success===false) throw Error(data.message||'Request failed'); return data;
    }
    function hideSecrets() {
      clearTimeout(hideTimer); $('epic-detail-secrets').hidden=true;
      $('epic-detail-saved-password').value=''; $('epic-detail-saved-totp').value='';
      $('epic-detail-reveal').textContent='Show saved credentials';
    }
    function fill(a) {
      selected=a; dirty=false; hideSecrets(); form.hidden=false;
      $('epic-detail-name').textContent=a.displayName||a.label||a.accountId;
      $('epic-detail-summary').textContent=[a.sold?'SOLD':'Unsold',a.status==='ok'?'Login connected':'Needs login',a.libraryCount+' games',a.hasPassword?'Password saved':'Password missing','Source: '+a.source,'Epic ID: '+a.accountId].join(' · ');
      for(const key of ['label','email']) form.elements[key].value=a[key]||'';
      for(const key of ['firstName','lastName','dateOfBirth','country','notes']) form.elements[key].value=a.details[key]||'';
      for(const key of ['password','totpSecret']) form.elements[key].value='';
      $('epic-detail-games').replaceChildren();
      for(const title of a.games.length?a.games:['No games recorded yet.']) {const li=document.createElement('li');li.textContent=title;$('epic-detail-games').append(li);}
      status(a.detailsUpdatedAt?'Last saved '+new Date(a.detailsUpdatedAt).toLocaleString():'No extra details saved yet.');
    }
    async function choose(id) {
      const version=++requestVersion; hideSecrets(); selected=null; form.hidden=true; dirty=false;
      if(!id) {status('Choose an account to view or edit its details.');return;}
      status('Loading account details…');
      try {const data=await request('/api/epic/accounts/'+encodeURIComponent(id)+'/details');if(version===requestVersion) {fill(data.account); if(!panel.hidden) history.replaceState(null,'','#details?account='+encodeURIComponent(id));}}
      catch(e){if(version===requestVersion) status(e.message,true);}
    }
    async function refresh() {
      if(dirty&&!confirm('Discard unsaved account detail changes?')) return;
      const before=select.value;
      try {
        const data=await request('/api/epic/accounts');
        select.replaceChildren(new Option('Choose an account',''));
        for(const a of data.accounts||[]) select.add(new Option((a.label||a.displayName||a.accountId)+(a.sold?' · SOLD':''),a._id));
        const wanted=new URLSearchParams(location.hash.split('?')[1]||'').get('account')||before;
        if([...select.options].some(o=>o.value===wanted)) select.value=wanted;
        await choose(select.value);
      } catch(e){status(e.message,true);}
    }
    select.addEventListener('change',()=>{
      if(dirty&&!confirm('Discard unsaved account detail changes?')) {select.value=selected?selected._id:'';return;}
      choose(select.value);
    });
    form.addEventListener('input',()=>{dirty=true;});
    form.addEventListener('submit',async event=>{
      event.preventDefault(); if(!selected)return;
      const id=selected._id, version=requestVersion;
      const body=Object.fromEntries(new FormData(form));
      $('epic-detail-save').disabled=true;
      try {
        const data=await request('/api/epic/accounts/'+id+'/details',{method:'PATCH',body:JSON.stringify(body)});
        if(version!==requestVersion)return;
        fill(data.account); select.selectedOptions[0].textContent=(data.account.label||data.account.displayName)+(data.account.sold?' · SOLD':'');
        status('Account details saved.');
        if(typeof window.load==='function') window.load();
      } catch(e){if(version===requestVersion) status(e.message,true);}
      finally{$('epic-detail-save').disabled=false;}
    });
    async function secrets(id) {return request('/api/epic/accounts/'+id+'/details/reveal',{method:'POST',body:'{}'});}
    $('epic-detail-reveal').addEventListener('click',async()=>{
      if(!selected)return;
      if(!$('epic-detail-secrets').hidden){hideSecrets();return;}
      const id=selected._id,version=requestVersion;
      try {
        const data=await secrets(id); if(version!==requestVersion||panel.hidden)return;
        $('epic-detail-saved-password').value=data.password||''; $('epic-detail-saved-totp').value=data.totpSecret||'';
        $('epic-detail-secrets').hidden=false; $('epic-detail-reveal').textContent='Hide saved credentials';
        hideTimer=setTimeout(hideSecrets,60000);
      } catch(e){status(e.message,true);}
    });
    $('epic-detail-copy').addEventListener('click',async()=>{
      if(!selected)return;
      if(dirty){status('Save your changes before copying sale details.',true);return;}
      const a=selected,version=requestVersion;
      try {
        const data=await secrets(a._id); if(version!==requestVersion||panel.hidden)return;
        const rows=[['Epic display name',a.displayName],['Epic account ID',a.accountId],['Email',data.email],['Epic password',data.password],['2FA setup key',data.totpSecret],['First name',a.details.firstName],['Last name',a.details.lastName],['Date of birth',a.details.dateOfBirth],['Country',a.details.country]];
        const text=rows.filter(([,v])=>v).map(([k,v])=>k+': '+v).join('\n')+'\nGames: '+(a.games.join(', ')||'No games recorded');
        await navigator.clipboard.writeText(text); status('Saved sale details copied.');
      } catch(e){status('Could not copy details. '+e.message,true);}
    });
    $('epic-detail-refresh').addEventListener('click',refresh);
    function tab(details) {
      if(!details&&dirty&&!confirm('Discard unsaved account detail changes?'))return;
      hideSecrets(); claimPanel.hidden=details; panel.hidden=!details;
      for(const [id,on] of [['epic-claims-tab',!details],['epic-details-tab',details]]) {
        $(id).setAttribute('aria-selected',String(on)); $(id).classList.toggle('btn-primary',on); $(id).tabIndex=on?0:-1;
      }
      history.replaceState(null,'',details?'#details':'#claims');
      if(details)refresh(); else dirty=false;
    }
    $('epic-claims-tab').addEventListener('click',()=>tab(false)); $('epic-details-tab').addEventListener('click',()=>tab(true));
    tabs.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const details=e.key==='End'||(e.key!=='Home'&&panel.hidden);tab(details);$(details?'epic-details-tab':'epic-claims-tab').focus();}});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)hideSecrets();});
    window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
    claimPanel.setAttribute('aria-labelledby','epic-claims-tab'); panel.setAttribute('aria-labelledby','epic-details-tab');
    const initial=location.hash.startsWith('#details');
    // Preserve account deep links for the first refresh.
    if(initial){claimPanel.hidden=true;panel.hidden=false;$('epic-details-tab').classList.add('btn-primary');refresh();}
    else tab(false);
    $('epic-claims-tab').setAttribute('aria-selected',String(!initial));$('epic-details-tab').setAttribute('aria-selected',String(initial));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
