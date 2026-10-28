const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('node:vm');
function driver(frames=[],bodyText="") {
 const source=fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'),'utf8');
 const start=source.lastIndexOf('  (async function () {');const context={location:{hash:''},window:{getComputedStyle:f=>f.style},document:{body:{textContent:bodyText},querySelectorAll:()=>frames},chrome:{},Date};
 vm.runInNewContext(source.slice(0,start)+'globalThis.api={registrationWaitState,captchaVisible,continueAfterChallenge,waitForStepChange};})();',context);return context.api;
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
