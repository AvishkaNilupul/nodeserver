const token=document.querySelector('meta[name="local-token"]').content;
let latest;
const labels={'queued':'Waiting to sign in','signed-in':'Game identity checked','linked':'Twitch paired','collected':'Mailbox collected','verified':'Inventory verified','logged-out':'Signed out'};
function el(tag,content,cls){const n=document.createElement(tag);if(content!==undefined)n.textContent=content;if(cls)n.className=cls;return n;}
async function api(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'X-Local-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Operation unavailable');return d;}
function notice(message){document.getElementById('notice').textContent=message;}
function button(label,action){const b=el('button',label,'secondary');b.addEventListener('click',async()=>{b.disabled=true;try{await action();}catch(e){notice(e.message);}finally{b.disabled=false;}});return b;}
async function copy(job,key,label){const d=await api('/api/jobs/'+job.id+'/credential',{key,copy:true});await navigator.clipboard.writeText(d.result.value);notice(label+' copied.');}
function render(d){
 latest=d;const ready=d.jobs.filter(j=>j.state==='ready').length,blocked=d.jobs.filter(j=>j.state==='blocked').length;
 const stats=document.getElementById('stats');stats.replaceChildren();
 for(const [n,label]of [[d.jobs.length,'Account pairs'],[ready,'Verified and ready'],[blocked,'Need attention']]){const c=el('div',undefined,'stat');c.append(el('strong',String(n)),el('span',label));stats.append(c);}
 const enabled=document.getElementById('enabled');enabled.textContent=d.enabled?'Pause queue':'Resume queue';
 const target=document.getElementById('jobs');target.replaceChildren();
 if(!d.jobs.length)target.append(el('p','No account pair has been allocated yet. The game download can continue independently.','empty'));
 for(const j of d.jobs){
  const card=el('article',undefined,'job');const top=el('div',undefined,'job-top');top.append(el('h3',j.steamLogin),el('span',j.state==='ready'?'Ready':j.state==='blocked'?'Needs attention':labels[j.phase], 'badge '+j.state));card.append(top);
  card.append(el('p','Twitch: '+j.twitchLogin+(j.rivalsUid?' · Rivals UID: '+j.rivalsUid:''),'muted'));
  const progress=el('ol',undefined,'phases');for(const p of d.phases){const i=el('li',labels[p]);if(d.phases.indexOf(p)<=d.phases.indexOf(j.phase))i.className='done';progress.append(i);}card.append(progress);
  if(j.block)card.append(el('p',j.block,'error'));
  if(j.mailExpiresAt)card.append(el('p','Mail deadline: '+new Date(j.mailExpiresAt).toLocaleString(),'muted'));
  const rewards=el('ul',undefined,'rewards');for(const r of j.expectedRewards)rewards.append(el('li',(j.verifiedRewards.includes(r.id)?'Verified: ':'Pending: ')+r.name));card.append(rewards);
  const actions=el('div',undefined,'actions');
  if(j.phase!=='logged-out'&&['pending','running'].includes(j.state))actions.append(button(j.phase==='queued'?'Prepare sign-in':'Prepare same-account sign-in',async()=>{const lease=await api('/api/acquire',{id:j.id,owner:'cua-rivals-worker'});await api('/api/jobs/'+j.id+'/begin-login',{leaseToken:lease.result.leaseToken});notice('Sign-in window prepared. Use this same account in the launcher or official Steam website.');await refresh();}));
  actions.append(button('Copy Steam login',async()=>{await navigator.clipboard.writeText(j.steamLogin);notice('Steam login copied.');}),button('Copy Steam password',()=>copy(j,'steamPassword','Steam password')),button('Copy Twitch login',async()=>{await navigator.clipboard.writeText(j.twitchLogin);notice('Twitch login copied.');}),button('Copy Twitch password',()=>copy(j,'twitchPassword','Twitch password')));
  if(j.loginStartedAt)actions.append(button('Copy Steam email code',async()=>{const d=await api('/api/jobs/'+j.id+'/guard',{copy:true});await navigator.clipboard.writeText(d.result.value);notice('Fresh Steam code copied.');}));
  if(j.state==='blocked')actions.append(button('Retry same account',async()=>{await api('/api/jobs/'+j.id+'/resume',{});await refresh();}));
  card.append(actions);target.append(card);
 }
 const observations=document.getElementById('observations');observations.replaceChildren();
 if(!d.observations.length)observations.append(el('p','No game-side verification has been recorded.','empty'));
 for(const o of [...d.observations].reverse().slice(0,30)){const item=el('article',undefined,'observation');item.append(el('strong',labels[o.phase]),el('time',new Date(o.observedAt).toLocaleString()),el('p',o.screen));observations.append(item);}
}
async function refresh(){try{render(await api('/api/state'));}catch(e){notice(e.message);}}
document.getElementById('enabled').addEventListener('click',async()=>{try{await api('/api/enabled',{enabled:!latest.enabled});await refresh();}catch(e){notice(e.message);}});
refresh();setInterval(refresh,5000);
