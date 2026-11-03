// Private, append-only demonstration journal. Credentials and SMS are excluded.
const fs=require('fs'),path=require('path');
const clean=(s,max=200)=>String(s||'').replace(/[\r\n]/g,' ').slice(0,max);
function eventRecord(id,body,now=()=>new Date()){
  let page='';try{const u=new URL(body.page);if(u.hostname==='naver.com'||u.hostname.endsWith('.naver.com'))page=u.origin+u.pathname;}catch{}
  const record={at:now().toISOString(),sessionId:id,kind:clean(body.kind,40),page,target:clean(body.target),label:clean(body.label),inputType:clean(body.inputType,40),trusted:body.trusted===true};
  const sensitive=/password|passwd|pwd|verification|verify|auth.?code|auth.?no|인증|비밀번호|one-time/i.test([record.target,record.label,record.inputType].join(' '));
  if(body.value!==undefined)record.value=sensitive?'[redacted]':/phone|mobile|전화/i.test(record.target+' '+record.label)?'…'+clean(body.value).slice(-4):clean(body.value,120);
  if(Array.isArray(body.cookies))record.cookies=body.cookies.slice(0,100).map(c=>({name:clean(c.name,80),domain:clean(c.domain,120),httpOnly:c.httpOnly===true,secure:c.secure===true,session:c.session===true}));
  return record;
}
function appendEvent(directory,id,body){
  const folder=path.join(directory,'recordings');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.appendFileSync(path.join(folder,'browser-events.jsonl'),JSON.stringify(eventRecord(id,body))+'\n',{mode:0o600});
}
module.exports={appendEvent,eventRecord};
