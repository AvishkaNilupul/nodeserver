// Page-world metadata observer. Never reads bodies, credentials or request headers.
(()=>{
 const notify=(url,status,retryAfter)=>{
  let u;try{u=new URL(url,location.href);}catch{return;}
  if(status!==429||u.origin!=='https://payment-website-pci.ol.epicgames.com'||u.pathname!=='/v2/purchase/confirm-order')return;
  const seconds=/^\d+$/.test(retryAfter||'')?Number(retryAfter):Math.max(0,Math.ceil((Date.parse(retryAfter)-Date.now())/1000));
  window.postMessage({source:'epic-claim-network',status:429,retryAfterSeconds:Number.isFinite(seconds)?seconds:0},location.origin);
 };
 const originalFetch=window.fetch;
 window.fetch=async function(...args){const r=await originalFetch.apply(this,args);try{notify(r.url,r.status,r.headers.get('retry-after'));}catch{}return r;};
 const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send,urls=new WeakMap();
 XMLHttpRequest.prototype.open=function(method,url,...rest){urls.set(this,String(url));return open.call(this,method,url,...rest);};
 XMLHttpRequest.prototype.send=function(...args){this.addEventListener('load',()=>{try{notify(this.responseURL||urls.get(this),this.status,this.getResponseHeader('retry-after'));}catch{}},{once:true});return send.apply(this,args);};
})();
