const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {createBackoff}=require('../utils/epicClaimBackoff');
test('worker cooldown survives new processes and expires without changing claim settings',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epic-backoff-')),file=path.join(dir,'cooldown.json');let now=1000;
 const a=createBackoff({file,now:()=>now});assert.equal(a.until(),0);assert.equal(a.block(120),121000);
 const b=createBackoff({file,now:()=>now});assert.equal(b.until(),121000);assert.equal(b.block(60),121000);
 now=122000;assert.equal(createBackoff({file,now:()=>now}).until(),0);
 fs.rmSync(dir,{recursive:true});
});
test('missing Retry-After uses a six-hour fallback and corrupt cooldown fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epic-backoff-')),file=path.join(dir,'cooldown.json');
 assert.equal(createBackoff({file,now:()=>1000}).block(0),21601000);
 fs.writeFileSync(file,'broken');assert.equal(createBackoff({file,now:()=>1000}).until(),21601000);fs.rmSync(dir,{recursive:true});
});
test('checkout network observer signals only order-confirmation 429 metadata',async()=>{
 const messages=[];let response;function XHR(){}XHR.prototype.open=function(){};XHR.prototype.send=function(){};
 const context={URL,WeakMap,Number,Math,Date,XMLHttpRequest:XHR,location:{href:'https://store.epicgames.com/purchase',origin:'https://store.epicgames.com'},window:{fetch:async()=>response,postMessage:m=>messages.push(m)}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-network.js'),'utf8'),context);
 for(const [url,status] of [['https://other.example/v2/purchase/confirm-order',429],['https://payment-website-pci.ol.epicgames.com/v2/purchase/order-preview',429],['https://payment-website-pci.ol.epicgames.com/v2/purchase/confirm-order',200]]){
  response={url,status,headers:{get:()=>null}};assert.equal(await context.window.fetch('fixture'),response);
 }
 assert.equal(messages.length,0);response={url:'https://payment-website-pci.ol.epicgames.com/v2/purchase/confirm-order',status:429,headers:{get:()=> '120'}};
 await context.window.fetch('fixture');assert.equal(messages.length,1);assert.equal(messages[0].status,429);assert.equal(messages[0].retryAfterSeconds,120);
});
