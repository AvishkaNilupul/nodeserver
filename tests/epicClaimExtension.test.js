const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function run(text,{assigned=true,offer='1-game-offer',buttonText='Add to library'}={}) {
 let tick,clicks=0;const reports=[];const location={hostname:'store.epicgames.com',pathname:'/purchase',search:'?offers='+offer,hash:'#/free-checkout'};
 const button={innerText:buttonText,disabled:false,getBoundingClientRect:()=>({width:100,height:30}),click(){clicks++;location.hash='#/receipt';}};
 const context={window:{},location,URLSearchParams,document:{body:{innerText:text},querySelectorAll:()=>[button]},getComputedStyle:()=>({visibility:'visible'}),setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout:()=>{},chrome:{runtime:{sendMessage:async msg=>{
  if(msg.type==='epicclaim-context')return {ok:assigned,job:{namespace:'game',offerId:'offer',displayName:'right-account'}};
  reports.push(msg);return {ok:true};
 }}}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-checkout.js'),'utf8'),context);
 if(tick){await tick();await tick();await tick();}
 return {clicks,reports};
}
test('assigned free checkout is clicked once and reported submitted',async()=>{
 const r=await run('right-account This is free. $0.00');assert.equal(r.clicks,1);assert.equal(r.reports[0].status,'submitted');
});
test('wrong account, paid price, and changed offer cannot be claimed',async()=>{
 for(const [text,opts] of [['wrong-account This is free. $0.00',{}],['right-account This is free. $9.99',{}],['right-account This is free. $0.00',{offer:'other'}]]){
 const r=await run(text,opts);assert.equal(r.clicks,0);assert.equal(r.reports[0].status,'error');
 }
});
test('unassigned Epic tabs are untouched',async()=>assert.equal((await run('right-account This is free. $0.00',{assigned:false})).clicks,0));
test('visible security checks are surfaced without clicking',async()=>{
 const r=await run('right-account One more step');assert.equal(r.clicks,0);assert.equal(r.reports[0].status,'needs_captcha');
});

test('zero prices in other currencies can be claimed',async()=>{
 for(const price of ['RUB 0.00','EUR 0,00','JPY 0'])assert.equal((await run('right-account This is free. '+price)).clicks,1);
});
test('nonzero currency amounts cannot pass as free',async()=>{
 for(const price of ['RUB 0.01','USD 10.00','EUR 0,99'])assert.equal((await run('right-account This is free. '+price)).clicks,0);
});

test('a regional purchase block is reported without clicking or waiting for timeout',async()=>{
 const r=await run('This product isn’t available in your region');assert.equal(r.clicks,0);assert.equal(r.reports[0].status,'region_unavailable');
});

test('paid checkout without a free-claim button fails immediately without clicking',async()=>{
 const r=await run('right-account Total ¥490',{buttonText:'Pay Now'});assert.equal(r.clicks,0);assert.equal(r.reports[0].status,'not_free');
});

test('a cleared hash with the checkout still visible is not an order confirmation',async()=>{
 // Unlike the successful fixture, this click leaves checkout text in place.
 const source=fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-checkout.js'),'utf8');
 let tick,timeout,clicks=0;const reports=[],location={hostname:'store.epicgames.com',pathname:'/purchase',search:'?offers=1-game-offer',hash:'#/free-checkout'};
 const button={innerText:'Add to library',disabled:false,getBoundingClientRect:()=>({width:1,height:1}),click(){clicks++;location.hash='#';}};
 await vm.runInNewContext(source,{window:{},Date,location,URLSearchParams,document:{body:{innerText:'right-account This is free. $0.00'},querySelectorAll:()=>[button]},getComputedStyle:()=>({visibility:'visible'}),setInterval:f=>(tick=f,1),clearInterval(){},setTimeout:f=>timeout=f,chrome:{runtime:{sendMessage:async m=>m.type==='epicclaim-context'?{ok:true,job:{namespace:'game',offerId:'offer',displayName:'right-account'}}:(reports.push(m),{ok:true})}}});
 await tick();await tick();assert.equal(clicks,1);assert.equal(reports.length,0);await timeout();assert.equal(reports[0].status,'error');
});

test('an enabled free checkout retries a missed initial click after ten seconds',async()=>{
 let tick,clock=1000,clicks=0;const reports=[],location={hostname:'store.epicgames.com',pathname:'/purchase',search:'?offers=1-game-offer',hash:'#/free-checkout'};
 const button={innerText:'Add to library',disabled:false,getBoundingClientRect:()=>({width:1,height:1}),click(){if(++clicks===2)location.hash='#/receipt';}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-checkout.js'),'utf8'),{window:{},Date:{now:()=>clock},location,URLSearchParams,document:{body:{innerText:'right-account This is free. $0.00'},querySelectorAll:()=>[button]},getComputedStyle:()=>({visibility:'visible'}),setInterval:f=>(tick=f,1),clearInterval(){},setTimeout(){},chrome:{runtime:{sendMessage:async m=>m.type==='epicclaim-context'?{ok:true,job:{namespace:'game',offerId:'offer',displayName:'right-account'}}:(reports.push(m),{ok:true})}}});
 await tick();clock+=9000;await tick();assert.equal(clicks,1);clock+=1000;await tick();await tick();assert.equal(clicks,2);assert.equal(reports[0].status,'submitted');
});
