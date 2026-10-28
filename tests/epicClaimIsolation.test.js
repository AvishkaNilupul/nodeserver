const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function check(isolateSessions) {
 const actions=[];let alarm;const connection={origin:'http://127.0.0.1:8123',token:'dummy',isolateSessions};
 const store={local:{get:async()=>({'epicclaim.connection':connection})},session:{get:async()=>({}),set:async()=>{}}};
 const chrome={storage:store,alarms:{create(){},onAlarm:{addListener:fn=>alarm=fn}},runtime:{onMessage:{addListener(){}}},browsingData:{removeCookies:async options=>actions.push({action:'clear',options})},tabs:{onUpdated:{addListener(){}},create:async()=>{actions.push({action:'create'});return{id:1};},update:async()=>actions.push({action:'navigate'})}};
 const context={chrome,fetch:async()=>({ok:true,json:async()=>({job:{id:'job',namespace:'ns',offerId:'offer',exchangeCode:'code'}})}),AbortSignal,URL,Date,console};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-background.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));return actions;
}
test('Epic cookies are cleared locally before opening an exchange link',async()=>{
 const a=await check(true);assert.deepEqual(a.map(x=>x.action),['clear','create','navigate']);assert.deepEqual(Array.from(a[0].options.origins),['https://www.epicgames.com']);
});
test('claims cannot navigate without session-isolation consent',async()=>assert.equal((await check(false)).length,0));
