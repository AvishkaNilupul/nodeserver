const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WineDriver,WineInput,windowsPath}=require('../tools/rivals-level-worker/wine-driver.cjs');
function root(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'rivals-input-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('bounded Windows packets carry only allowlisted keyboard and mouse input',async()=>{
 const input=Object.create(WineInput.prototype);let sent;input.command=async line=>{sent=line;return {ok:true};};
 await input.controls({keys:['w','space'],dx:40,dy:-5,milliseconds:900,fire:true});assert.equal(sent,'control 40 -5 900 1 1025');
 for(const p of [{keys:['unknown'],milliseconds:20},{keys:[],milliseconds:3001},{keys:[],milliseconds:20,dx:401},{keys:[],milliseconds:20,dy:NaN}])await assert.rejects(input.controls(p),/bounded/);
 assert.equal(windowsPath('/Users/example/Input Worker/native.exe'),'Z:\\Users\\example\\Input Worker\\native.exe');
 assert.throws(()=>windowsPath('/tmp/a\nb'),/path/);
});
test('a failed native focus check prevents Windows input from starting',async t=>{
 let started=0;const d=new WineDriver('/fixture/native',{bottle:'Fixture',directoryRoot:root(t),nativeFactory:()=>({request:async()=>{throw Error('Game lost focus');},close:async()=>{}}),wineFactory:()=>{started++;throw Error('Must not start');}});
 await assert.rejects(d.request({command:'controls',keys:['w'],milliseconds:100}),/lost focus/);assert.equal(started,0);await d.close();
});
test('native focus loss aborts a mouse hold, waits for release, and removes its private abort marker',async t=>{
 const directoryRoot=root(t);let marker,abortObserved=false,nativeKeys;
 const d=new WineDriver('/fixture/native',{bottle:'Fixture',directoryRoot,nativeFactory:()=>({request:async p=>{if(p.command==='watch'&&p.milliseconds===100){nativeKeys=p.keys;assert.equal(p.abortFile,marker);throw Error('Game lost focus');}return {};},close:async()=>{}}),wineFactory:settings=>{
   marker=settings.abortFile;return {ready:Promise.resolve(),controls:async p=>{assert.deepEqual(p.keys,['w']);await new Promise(r=>setTimeout(r,20));abortObserved=fs.existsSync(marker);throw Error('Mouse hold released');},close:async()=>{}};
 }});
 await assert.rejects(d.request({command:'controls',keys:['w'],milliseconds:100,fire:true}),/lost focus|released/);
 assert.deepEqual(nativeKeys,[]);assert.equal(abortObserved,true);assert.equal(fs.existsSync(marker),false);await d.close();
});
test('invalid combined input is rejected before either backend receives it',async t=>{
 let calls=0;const d=new WineDriver('/fixture/native',{bottle:'Fixture',directoryRoot:root(t),nativeFactory:()=>({request:async()=>{calls++;return {};},close:async()=>{}})});
 await assert.rejects(d.request({command:'controls',keys:['unknown'],milliseconds:100,fire:true}),/bounded/);assert.equal(calls,0);await d.close();
});

test('Escape uses its isolated menu path and keeps the native watcher running through startup',async t=>{
 let mouseCalls=0,menuCalls=0;const watches=[];
 const d=new WineDriver('/fixture/native',{bottle:'Fixture',directoryRoot:root(t),nativeFactory:()=>({request:async p=>{watches.push(p.milliseconds);await new Promise(r=>setTimeout(r,1));return {};},close:async()=>{}}),wineFactory:()=>({ready:Promise.resolve(),controls:async()=>{mouseCalls++;throw Error('Unexpected gameplay keys');},close:async()=>{}}),menuFactory:async(settings,ms)=>{menuCalls++;assert.equal(ms,100);assert.ok(settings.abortFile);await new Promise(r=>setTimeout(r,3));return {ok:true};}});
 await d.request({command:'controls',keys:['escape'],milliseconds:100});assert.equal(menuCalls,1);assert.equal(mouseCalls,0);assert.ok(watches.includes(3000));
 await assert.rejects(d.request({command:'controls',keys:['escape','w'],milliseconds:100}),/separate bounded/);await d.close();
});
