const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('node:vm');
function driver(frames=[],bodyText="",pathname="/id/register") {
 const source=fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'),'utf8');
 const start=source.lastIndexOf('  (async function () {');const context={location:{hash:'',pathname},window:{getComputedStyle:f=>f.style},document:{body:{textContent:bodyText},querySelectorAll:()=>frames},chrome:{},Date};
 vm.runInNewContext(source.slice(0,start)+'globalThis.api={registrationWaitState,captchaVisible,continueAfterChallenge,waitForStepChange,serviceUnavailable};})();',context);return context.api;
}
test('a visible challenge pauses registration timeout and reports its real state',()=>{
 const {registrationWaitState}=driver(),state={deadline:120000,lastPoll:0,waitingMs:0,challengeSeen:false};
 const wait=registrationWaitState(state,true,900000);assert.equal(wait.status,'awaiting_captcha');assert.equal(wait.timedOut,false);assert.equal(state.waitingMs,900000);
 const resumed=registrationWaitState(state,false,901000);assert.equal(resumed.timedOut,false);assert.equal(state.deadline,1021000);
 assert.equal(registrationWaitState(state,false,1021001).timedOut,true);
});
test('ordinary submission still times out when no challenge is blocking it',()=>{
 const state={deadline:120000,lastPoll:0,waitingMs:0,challengeSeen:false};assert.equal(driver().registrationWaitState(state,false,120001).timedOut,true);
});
test('fixed-position challenge frames count; hidden SDK frames do not',()=>{
 const frame=style=>({offsetParent:null,getBoundingClientRect:()=>({width:400,height:500}),style:{display:'block',visibility:'visible',opacity:'1',...style}});
 assert.equal(driver([frame({})]).captchaVisible(),true);
 for(const style of [{visibility:'hidden'},{display:'none'},{opacity:'0'}])assert.equal(driver([frame(style)]).captchaVisible(),false);
});

test('temporary Epic failures stop navigation and prevent captcha resubmission',async()=>{
 const api=driver([], 'Sorry, the service is temporarily unavailable. Please try back later.');
 assert.equal(api.continueAfterChallenge({seen:true,clearedAt:1,clicks:0},false),false);
 await assert.rejects(api.waitForStepChange('otp',10000),/temporarily unavailable/);
});

test('navigation survives an eight-minute challenge and waits for the response',async()=>{
 const source=fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'),'utf8');
 const start=source.lastIndexOf('  (async function () {');let now=1000;
 const loc={hash:'',pathname:'/id/login/mfa',hostname:'www.epicgames.com'};
 const frame={getBoundingClientRect:()=>({width:400,height:500}),style:{display:'block',visibility:'visible',opacity:'1'}};
 const context={location:loc,window:{getComputedStyle:f=>f.style},document:{body:{textContent:''},getElementById:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector.includes('iframe')?(now<481000?[frame]:[]):selector.includes('code-input-')?Array(6).fill({}):[]},chrome:{},Date:{now:()=>now},setTimeout:fn=>{now+=400;if(now>=481800)loc.hostname='store.epicgames.com';fn();}};
 vm.runInNewContext(source.slice(0,start)+'globalThis.api={waitForStepChange};})();',context);
 assert.equal(await context.api.waitForStepChange('otp',1000),'done');
 assert.ok(now>=481800);
});

test('an invalid code after a long challenge still reads a fresh email',async()=>{
 const source=fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'),'utf8');
 const start=source.lastIndexOf('  (async function () {');let now=1000,reads=0,responses=0;
 const boxes=Array.from({length:6},()=>({focus(){},dispatchEvent(){}}));
 const context={location:{hash:''},window:{},document:{querySelectorAll:()=>boxes},chrome:{},Date:{now:()=>now},KeyboardEvent:class{},advance:ms=>{now+=ms;},reply:()=>{responses++;now+=360000;return responses===1?'otp_invalid':'done';},read:()=>{reads++;return reads===1?'111111':'222222';}};
 const hooks=`sleep=async ms=>advance(ms);banner=()=>{};setVal=(el,v)=>{el.value=v;};clickResendCode=()=>true;waitFor=async fn=>true;waitForStepChange=async()=>reply();sw=async m=>m.type==='epicgen-request-otp'?{ok:true,code:read()}:{ok:true};globalThis.api={handleOtpStep};})();`;
 vm.runInNewContext(source.slice(0,start)+hooks,context);
 await context.api.handleOtpStep();assert.equal(reads,2);assert.equal(boxes.map(b=>b.value).join(''),'222222');
});

test('an insufficient-authentication agreement requests sign-in recovery immediately',async()=>{
 const api=driver([], 'Insufficient User Authentication', '/id/login/correction/eula');
 assert.equal(await api.waitForStepChange('agreement',1000),'auth_context_rejected');
});

test('storefront error templates do not stop successful authorization handoff',()=>{
 assert.equal(driver([], 'Please try again later', '/en-US/').serviceUnavailable(),false);
});

test('dismissing a challenge without its SDK response does not resubmit',()=>{
 assert.equal(driver().continueAfterChallenge({seen:true,clearedAt:1,clicks:0},false),false);
});
