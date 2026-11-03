if(location.origin==='http://127.0.0.1:4109'&&location.pathname==='/')window.addEventListener('message',async e=>{
  if(e.source!==window||e.origin!==location.origin||e.data?.channel!=='chzzk-local-request')return;
  const {id,type,token,sessionId}=e.data;
  if(typeof id!=='string'||!['connect','open','resume','number','sms','replace','save','close'].includes(type))return;
  try{const result=await chrome.runtime.sendMessage({type,token,sessionId});window.postMessage({channel:'chzzk-local-response',id,result},location.origin);}
  catch{window.postMessage({channel:'chzzk-local-response',id,result:{ok:false,error:'Reload this page after enabling the CHZZK extension.'}},location.origin);}
});
