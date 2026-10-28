const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function fixture({mode='recover',pathname='/id/login/review/mfa-settings',raw=''}={}) {
 let tick,confirms=0,updates=0;const messages=[];
 const confirm={innerText:'Confirm',disabled:false,getBoundingClientRect:()=>({width:100,height:20}),click:()=>confirms++};
 const update={...confirm,innerText:'Update authentication methods',click:()=>updates++};
 const document={body:{innerText:raw,textContent:raw},querySelector:()=>null,querySelectorAll:type=>type==='button'?[confirm,update]:[]};
 const context={document,location:{pathname},getComputedStyle:()=>({visibility:'visible'}),Date,Map,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout:()=>{},chrome:{runtime:{sendMessage:async msg=>{
 if(msg.type==='epicclaim-context')return {ok:true,job:{mode}};messages.push(msg);return {ok:true};
 }}}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-recover.js'),'utf8'),context);
 if(tick)await tick();return{confirms,updates,messages};
}
test('review confirms existing authentication methods without opening changes',async()=>{
 const r=await fixture();assert.equal(r.confirms,1);assert.equal(r.updates,0);
});
test('ordinary claim jobs cannot enter the recovery handler',async()=>assert.equal((await fixture({mode:'claim'})).confirms,0));
test('authorization code capture accepts only the expected code format',async()=>{
 const r=await fixture({pathname:'/id/api/redirect',raw:JSON.stringify({authorizationCode:'f'.repeat(32)})});assert.equal(r.messages[0].status,'reauthorized');assert.equal(r.messages[0].code,'f'.repeat(32));
 const bad=await fixture({pathname:'/id/api/redirect',raw:JSON.stringify({authorizationCode:'invalid'})});assert.equal(bad.messages.length,0);
});
test('OTP submission waits for React to enable Continue without refetching the same code',async()=>{
 let tick,enabled=false,clicks=0,fetches=0;
 class Input {constructor(){this.type='text';this.name='code-input-0';this.maxLength=1;this._value='';}get value(){return this._value;}set value(v){this._value=v;}getBoundingClientRect(){return{width:20,height:20};}dispatchEvent(){}}
 const inputs=Array.from({length:6},()=>new Input());
 const button={innerText:'Continue',get disabled(){return !enabled;},getBoundingClientRect:()=>({width:100,height:20}),click:()=>clicks++};
 const context={document:{body:{innerText:''},querySelectorAll:type=>type==='input'?inputs:[button]},location:{pathname:'/id/login/mfa'},getComputedStyle:()=>({visibility:'visible'}),HTMLInputElement:Input,Event:class{},Date,Map,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout:()=>{},chrome:{runtime:{sendMessage:async msg=>{
 if(msg.type==='epicclaim-context')return {ok:true,job:{mode:'recover'}};
 if(msg.type==='epicclaim-otp'){fetches++;return{code:'123456'};}return {ok:true};
 }}}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-recover.js'),'utf8'),context);
 await tick();assert.equal(clicks,0);enabled=true;await tick();assert.equal(clicks,1);assert.equal(fetches,1);
});
