const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
test('an unavailable server is explained before any Outlook reservation or extension action',async()=>{
 const nodes={};for(const id of ['signupStatus','signupStart','signupCancel','signupResume','signupRecover'])nodes[id]={textContent:'',disabled:false,addEventListener(type,fn){this[type]=fn;}};
 let extensionCalls=0;
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{
  document:{getElementById:id=>nodes[id]},window:{addEventListener(){},postMessage(){extensionCalls++;}},fetch:async()=>{throw TypeError('Failed to fetch');},setTimeout,clearTimeout,location:{origin:'https://panel.test'},
 });
 await nodes.signupStart.click();assert.equal(extensionCalls,0);assert.match(nodes.signupStatus.textContent,/Cannot reach the local generator/);assert.equal(nodes.signupStart.disabled,false);
});

test('recovery selects an older interrupted signup after a newer successful account',async()=>{
 for(const chosen of ['', 'older']){
  const nodes={};for(const id of ['signupStatus','signupStart','signupCancel','signupResume','signupRecover','signupProxy','signupAuto','signupSession'])nodes[id]={textContent:'',disabled:false,checked:true,value:id==='signupSession'?chosen:'',addEventListener(type,fn){this[type]=fn;}};
  const listeners=new Set(),requests=[];const window={addEventListener:(t,fn)=>listeners.add(fn),removeEventListener:(t,fn)=>listeners.delete(fn),postMessage(msg){for(const fn of [...listeners])fn({source:window,origin:'http://127.0.0.1:4107',data:{type:msg.type+'-ack',ok:true,payload:msg.type==='epicgen-ping'?{version:'1.5.0'}:{}}});}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{
   document:{getElementById:id=>nodes[id],querySelector:()=>null},window,setTimeout,clearTimeout,location:{origin:'http://127.0.0.1:4107'},fetch:async path=>{
    requests.push(path);const data=path.includes('/recent')?{success:true,sessions:[{sessionId:'newer',status:'verified'},{sessionId:'older',status:'failed'}]}:path.endsWith('/resume')?{success:true,session:{sessionId:'older',mailbox:{address:'older@outlook.com'}}}:{success:true};return{ok:true,json:async()=>data};
   },
  });
  await nodes.signupRecover.click();assert.ok(requests.includes('/api/epic/signup/older/resume'));assert.equal(requests.some(p=>p.includes('/newer/resume')),false);
 }
});
