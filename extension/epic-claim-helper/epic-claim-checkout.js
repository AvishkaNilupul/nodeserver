(async()=>{
 if(window.__epicClaimCheckout)return;window.__epicClaimCheckout=true;
 const context=await chrome.runtime.sendMessage({type:'epicclaim-context'}).catch(()=>null);if(!context?.ok||context.job?.mode==='recover')return;
 const job=context.job;let clicked=false,done=false,emptyReceiptAt=0,lastClickAt=0,clickAttempts=0;
 const report=async(status,error='',extra={})=>{if(done)return;done=true;await chrome.runtime.sendMessage({type:'epicclaim-result',status,error,...extra});};
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.source!=='epic-claim-network'||event.data.status!==429)return;
  report('rate_limited','Epic returned HTTP 429; the claim queue is paused',{retryAfterSeconds:Number(event.data.retryAfterSeconds)||0});
 });
 const visible=el=>!!el&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden';
 const timer=setInterval(async()=>{
  if(done){clearInterval(timer);return;}
  const text=document.body?.innerText||'';
  if(location.pathname.startsWith('/id/login'))return report('session_failed','Epic requested sign-in');
  if(location.hostname!=='store.epicgames.com'||location.pathname!=='/purchase')return;
  const offer=new URLSearchParams(location.search).get('offers');if(offer!=='1-'+job.namespace+'-'+job.offerId)return report('error','Checkout offer changed');
  if(/(?:product|offer|game).{0,80}(?:not\s+available|isn.t\s+available|unavailable).{0,40}(?:region|country)|not available in your (?:region|country)/i.test(text))return report('region_unavailable','Epic says this product is not available in this account’s region');
  if(/you already own|already in your library/i.test(text))return report('already_owned');
  if(/one more step|please complete a security check/i.test(text))return report('needs_captcha','Complete the visible security check in the claim tab');
  if(clicked){
   if(/^#\/receipt/.test(location.hash)||/thanks for your order|successfully added|order is complete/i.test(text))return report('submitted');
   // The router also clears its hash while the order request is still pending.
   // A stable empty receipt is completion; a transient hash change is not.
   if((location.hash===''||location.hash==='#')&&!text.trim()){
    if(!emptyReceiptAt)emptyReceiptAt=Date.now();
    if(Date.now()-emptyReceiptAt>=5000)return report('submitted');
   }else emptyReceiptAt=0;
   const retryButton=[...document.querySelectorAll('button')].find(b=>/^add to library$/i.test(b.innerText.trim())&&visible(b)&&!b.disabled);
   if(clickAttempts<3&&Date.now()-lastClickAt>=10000&&retryButton)clicked=false;
   else return;
  }
  const button=[...document.querySelectorAll('button')].find(b=>/^add to library$/i.test(b.innerText.trim())&&visible(b)&&!b.disabled);
  if(!button){
   const paidTotal=[...document.querySelectorAll('button')].some(b=>/^pay now$/i.test(b.innerText.trim()));
   if(paidTotal)return report('not_free','Epic is showing a paid checkout; no order was submitted');
   return;
  }
  if(!text.includes(job.displayName))return report('error','Checkout account does not match assigned account');
  const prices=[...text.matchAll(/(?:[$€£¥₽₹₩₺₴₫]|\b[A-Z]{3})\s*(\d+(?:[.,]\d+)?)/g)].map(m=>Number(m[1].replace(',','.')));
  if(!/this is free/i.test(text)||!prices.length||prices.some(price=>price!==0))return report('error','Checkout is not explicitly free');
  clicked=true;lastClickAt=Date.now();clickAttempts++;button.click();
 },1000);
 setTimeout(()=>{clearInterval(timer);report('error',clicked?'Checkout did not confirm completion; verify library':'Checkout did not finish');},110000);
})();
