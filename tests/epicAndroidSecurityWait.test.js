const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');
execFileSync(process.execPath,[path.join(root,'extension/epic-claim-helper-android/build.cjs')]);
const source=fs.readFileSync(path.join(root,'extension/epic-claim-helper-android/dist/epic-claim-checkout.js'),'utf8');
async function fixture(){
 let tick,timeout,clicks=0,text='One more step. Please complete a security check',results=[];
 const location={hostname:'store.epicgames.com',pathname:'/purchase',search:'?offers=1-ns-offer',hash:'#/checkout',origin:'https://store.epicgames.com'};
 const button={innerText:'Add to library',disabled:false,getBoundingClientRect:()=>({width:100,height:20}),click(){clicks++}};
 const context={Date,URLSearchParams,location,window:{addEventListener(){}},getComputedStyle:()=>({visibility:'visible'}),document:{body:{get innerText(){return text}},querySelectorAll:()=>[button]},
 ext:{runtime:{sendMessage:async msg=>{if(msg.type==='epicclaim-context')return {ok:true,job:{namespace:'ns',offerId:'offer',displayName:'AssignedName'},deadline:Date.now()+120000};results.push(msg);return {ok:true}}}},
 setInterval:fn=>{tick=fn},clearInterval(){},setTimeout:fn=>{timeout=fn}};
 await vm.runInNewContext(source,context);return {tick:()=>tick(),timeout:()=>timeout(),setText:t=>text=t,location,results,clicks:()=>clicks};
}
test('Android keeps assignment through security check and submits the same verified free checkout afterwards',async()=>{
 const f=await fixture();await f.tick();assert.equal(f.results.length,0);assert.equal(f.clicks(),0);
 f.setText('AssignedName $0 This is free. Add to library');await f.tick();assert.equal(f.clicks(),1);
 f.location.hash='#/receipt';f.setText('Thanks for your order');await f.tick();assert.equal(f.results[0].status,'submitted');
});
test('unresolved security check eventually pauses instead of submitting or hanging forever',async()=>{
 const f=await fixture();await f.tick();f.timeout();await new Promise(setImmediate);assert.equal(f.results[0].status,'needs_captcha');assert.equal(f.clicks(),0);
});
