(() => {
 if(location.origin!=='http://127.0.0.1:8123'&&location.origin!=='http://127.0.0.1:8125')return;
 if(location.pathname!=='/connect')return;
 const button=document.getElementById('connect'),status=document.getElementById('status');if(!button)return;
 button.addEventListener('click',async()=>{
  if(!document.getElementById('accept')?.checked){status.textContent='Select the free-game checkout agreement to enable claims.';return;}
  const result=await chrome.runtime.sendMessage({type:'epicclaim-enable',token:button.dataset.token,isolateSessions:document.getElementById('isolate')?.checked===true});
  status.textContent=result?.ok?'Connected. Browser claims are enabled while Chrome is open.':result?.error||'Connection failed';
 });
})();
