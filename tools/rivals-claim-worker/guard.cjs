const CODE=/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;
function guardCode(messages,since){
 const after=Date.parse(since)-60000;if(!Number.isFinite(after))throw Error('A valid sign-in time is required');
 for(const m of [...(messages||[])].sort((a,b)=>Date.parse(b.receivedDateTime)-Date.parse(a.receivedDateTime))){
  const sender=m.from?.emailAddress?.address||'';
  if(!/^[^@\s]+@steampowered\.com$/i.test(sender)||/new steam account email verification/i.test(m.subject||'')||!(Date.parse(m.receivedDateTime)>=after))continue;
  const body=typeof m.body==='string'?m.body:m.body?.content||'';
  const text=(body+' '+(m.bodyPreview||'')).replace(/<(style|script)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ');
  const code=text.split(/[^A-Za-z0-9]+/).find(x=>CODE.test(x));if(code)return code;
 }
 return null;
}
async function readGuard({email,since},{fetcher=fetch}={}){
 if(!/^[^\s@]+@(?:outlook|hotmail|live)\.[a-z.]+$/i.test(email||''))throw Object.assign(Error('No dedicated Outlook inbox is available for this account'),{status:409});
 const r=await fetcher('http://127.0.0.1:3999/api/accounts/'+encodeURIComponent(email)+'/read?top=10',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Object.assign(Error('The assigned mailbox could not be read; retry the same sign-in'),{status:503});
 const data=await r.json();if(!data.ok)throw Object.assign(Error('The assigned mailbox could not be read; retry the same sign-in'),{status:503});
 const code=guardCode(data.messages,since);if(!code)throw Object.assign(Error('No fresh Steam code has arrived yet'),{status:409});return code;
}
module.exports={guardCode,readGuard};
