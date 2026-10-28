const test=require('node:test'),assert=require('node:assert/strict');
const {isFreeCheckout,visibleChallenge,checkout,validJob}=require('../tools/epic-claim-worker/browser-worker.cjs');
test('only explicit free checkout is eligible',()=>{
 assert.equal(isFreeCheckout('Sker Ritual $0.00 This is free.'),true);
 assert.equal(isFreeCheckout('Sker Ritual $9.99 Free shipping'),false);
 assert.equal(isFreeCheckout('Sker Ritual $0.00'),false);
});
function page({hidden=true,text='This is free. Sker Ritual $0.00',receipt=true}={}) {
 let clicked=0,url='https://store.epicgames.com/purchase#/free-checkout';
 return {goto:async()=>{},url:()=>url,locator:()=>({innerText:async()=>text}),
 getByText:()=>({first:()=>({isVisible:async()=>false})}),
 getByRole:()=>({isVisible:async()=>true,click:async()=>{clicked++;if(receipt)url='https://store.epicgames.com/purchase#';}}),
 frames:()=>[{url:()=> 'https://newassets.hcaptcha.com/captcha?frame=challenge',frameElement:async()=>({isVisible:async()=>!hidden,boundingBox:async()=>({width:400,height:500})})}],
 clicks:()=>clicked};
}
const job={exchangeCode:'a'.repeat(32),namespace:'b'.repeat(32),offerId:'c'.repeat(32),accountKey:'d'.repeat(32)};
test('hidden captcha iframe does not count as a visible challenge',async()=>assert.equal(await visibleChallenge(page()),false));
test('visible challenge is returned without clicking or solving',async()=>{
 const p=page({hidden:false});assert.equal((await checkout(p,job,{sleep:async()=>{}})).status,'needs_captcha');assert.equal(p.clicks(),0);
});
test('blank hash completion submits once and requires library verification',async()=>{
 const p=page();assert.deepEqual(await checkout(p,job,{sleep:async()=>{}}),{status:'submitted'});assert.equal(p.clicks(),1);
});
test('paid checkout cannot be submitted',async()=>{
 const p=page({text:'Paid game $19.99'});assert.equal((await checkout(p,job,{sleep:async()=>{}})).status,'error');assert.equal(p.clicks(),0);
});
test('jobs require account identity and exact offer identifiers',()=>{
 assert.equal(validJob(job),true);assert.equal(validJob({...job,accountKey:'../shared'}),false);assert.equal(validJob({...job,offerId:''}),false);
});
