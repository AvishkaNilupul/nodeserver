// Click the initial checkbox only. Image/puzzle challenges are always left to the operator.
(async()=>{
  const parameters=new URLSearchParams(location.hash.slice(1));
  if(parameters.get('frame')!=='checkbox'||parameters.get('host')!=='store.steampowered.com')return;
  let permission;try{permission=await chrome.runtime.sendMessage({type:'captcha-frame'});}catch{return;}
  if(!permission?.ok||!permission.autoClick)return;
  let attempted=false,ticks=0;
  function check(){
    if(attempted||++ticks>40){clearInterval(timer);return;}
    const box=document.getElementById('checkbox');
    if(!box||!box.getClientRects().length)return;
    if(box.getAttribute('aria-checked')==='true'){clearInterval(timer);return;}
    attempted=true;box.click();clearInterval(timer);
  }
  const timer=setInterval(check,500);check();
})();
