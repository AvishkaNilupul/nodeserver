if(location.origin==='http://127.0.0.1:4108' && location.pathname==='/') {
  window.addEventListener('message',async event=>{
    if(event.source!==window || event.origin!==location.origin || event.data?.channel!=='steam-local-request')return;
    const {id,type,token,country,sampleContact,autoSubmit}=event.data;
    if(!['connect','start','resume','status'].includes(type)||typeof id!=='string')return;
    try {const result=await chrome.runtime.sendMessage({type,token,country,sampleContact,autoSubmit});window.postMessage({channel:'steam-local-response',id,result},location.origin);}
    catch {window.postMessage({channel:'steam-local-response',id,result:{ok:false,error:'Reload this page after enabling the Steam extension'}},location.origin);}
  });
}
