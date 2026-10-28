const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function run(text,{assigned=true,offer='1-game-offer'}={}) {
 let tick,clicks=0;const reports=[];const location={hostname:'store.epicgames.com',pathname:'/purchase',search:'?offers='+offer,hash:'#/free-checkout'};
 const button={innerText:'Add to library',disabled:false,getBoundingClientRect:()=>({width:100,height:30}),click(){clicks++;location.hash='#';}};
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
