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
  const listeners=new Set(),requests=[];const window={addEventListener:(t,fn)=>listeners.add(fn),removeEventListener:(t,fn)=>listeners.delete(fn),postMessage(msg){for(const fn of [...listeners])fn({source:window,origin:'http://127.0.0.1:4107',data:{type:msg.type+'-ack',ok:true,payload:msg.type==='epicgen-ping'?{version:'1.5.1'}:{}}});}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{
   document:{getElementById:id=>nodes[id],querySelector:()=>null},window,setTimeout,clearTimeout,location:{origin:'http://127.0.0.1:4107'},fetch:async path=>{
    requests.push(path);const data=path.includes('/recent')?{success:true,sessions:[{sessionId:'newer',status:'verified'},{sessionId:'older',status:'failed'}]}:path.endsWith('/resume')?{success:true,session:{sessionId:'older',mailbox:{address:'older@outlook.com'}}}:{success:true};return{ok:true,json:async()=>data};
   },
  });
  await nodes.signupRecover.click();assert.ok(requests.includes('/api/epic/signup/older/resume'));assert.equal(requests.some(p=>p.includes('/newer/resume')),false);
 }
});

function batchPanel({count='5',auto=true,failAllocate=false,failDrive=false}={}) {
 const nodes={},listeners=new Set(),timers=new Map(),calls=[],bodies=[];let nextTimer=0,sequence=0;
 for(const id of ['signupStatus','signupStart','signupCancel','signupResume','signupRecover','signupProxy','signupAuto','signupSampleContact','signupSession','signupBatchCount','signupBatchStart','signupBatchStop','signupBatchStatus'])nodes[id]={textContent:'',disabled:false,checked:id==='signupAuto'?auto:false,value:id==='signupBatchCount'?count:'',addEventListener(type,fn){this[type]=fn;}};
 const window={addEventListener:(t,fn)=>listeners.add(fn),removeEventListener:(t,fn)=>listeners.delete(fn),postMessage(msg){
  calls.push(msg);const ok=!(failAllocate&&msg.type==='epicgen-allocate')&&!(failDrive&&msg.type==='epicgen-drive');
  const payload=msg.type==='epicgen-ping'?{version:'1.5.1'}:msg.type==='epicgen-allocate'?{mailbox:{address:'test@example.com'}}:{};
  for(const fn of [...listeners])fn({source:window,origin:'http://local',data:{type:msg.type+'-ack',ok,error:'No inbox available',payload}});
 }};
 const relay=(kind,id='session-'+sequence,extra={})=>{for(const fn of [...listeners])fn({source:window,origin:'http://local',data:{type:'epicgen-relay',payload:{kind,sessionId:id,...extra}}});};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{
  document:{getElementById:id=>nodes[id],querySelector:()=>null},window,location:{origin:'http://local'},
  setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  fetch:async(path,init)=>{let data={success:true};if(path.endsWith('/start')){bodies.push(JSON.parse(init.body));data.session={sessionId:'session-'+(++sequence)};}return{ok:true,json:async()=>data};},
 });
 return {nodes,calls,bodies,relay,async next(){const pair=[...timers].find(([,t])=>t.ms===5000);assert.ok(pair,'next signup must be scheduled');timers.delete(pair[0]);pair[1].fn();for(let i=0;i<25;i++)await Promise.resolve();},allocations:()=>calls.filter(c=>c.type==='epicgen-allocate').length};
}
test('batch runs exactly the chosen count, waits for verification, and ignores duplicate/foreign completion',async()=>{
 const h=batchPanel();await h.nodes.signupBatchStart.click();assert.equal(h.allocations(),1);
 h.relay('status',undefined,{status:'awaiting_captcha'});assert.match(h.nodes.signupBatchStatus.textContent,/batch will wait/);assert.equal(h.allocations(),1);
 h.relay('verified','unrelated');assert.equal(h.allocations(),1);
 h.nodes.signupProxy.checked=true; // Settings were captured when the batch started.
 for(let i=1;i<=5;i++){
  h.relay('verified','session-'+i);h.relay('verified','session-'+i);
  assert.equal(h.allocations(),i);
  if(i<5){await h.next();assert.equal(h.allocations(),i+1);}
 }
 assert.match(h.nodes.signupBatchStatus.textContent,/Batch complete. 5 of 5 saved/);
 assert.equal(h.nodes.signupBatchStart.disabled,false);assert.ok(h.calls.filter(c=>c.type==='epicgen-allocate').every(c=>!c.useProxy));
});
test('stop after current saves the active account without allocating another inbox',async()=>{
 const h=batchPanel();await h.nodes.signupBatchStart.click();h.nodes.signupBatchStop.click();h.relay('verified');
 assert.match(h.nodes.signupBatchStatus.textContent,/Batch stopped. 1 of 5 saved/);assert.equal(h.allocations(),1);
 assert.equal(h.calls.some(c=>c.type==='epicgen-cancel'),false);
});
test('stop during the gap clears the queued next signup',async()=>{
 const h=batchPanel();await h.nodes.signupBatchStart.click();h.relay('verified');h.nodes.signupBatchStop.click();
 assert.match(h.nodes.signupBatchStatus.textContent,/Batch stopped. 1 of 5 saved/);assert.equal(h.nodes.signupBatchStart.disabled,false);
});
test('failures and completion warnings stop a batch without skipping the current identity',async()=>{
 for(const kind of ['failed','verified']){
  const h=batchPanel();await h.nodes.signupBatchStart.click();h.relay(kind,undefined,{error:'Signup failed',...(kind==='verified'?{warning:'Close the private window'}:{})});
  assert.match(h.nodes.signupBatchStatus.textContent,/Batch stopped:/);assert.equal(h.allocations(),1);assert.equal(h.nodes.signupBatchStart.disabled,false);
 }
 const h=batchPanel({failAllocate:true});await h.nodes.signupBatchStart.click();assert.match(h.nodes.signupBatchStatus.textContent,/No inbox available/);assert.equal(h.bodies.length,0);
});
test('invalid counts and disabled automatic submission do not reserve inboxes',async()=>{
 for(const options of [{count:'0'},{count:'1.5'},{count:'51'},{count:'abc'},{auto:false}]){
  const h=batchPanel(options);await h.nodes.signupBatchStart.click();assert.equal(h.allocations(),0);assert.equal(h.nodes.signupBatchStart.disabled,false);
 }
});

test('same-tab retry restores panel tracking after failure without restarting a stopped batch',async()=>{
 const h=batchPanel({count:'3'});await h.nodes.signupBatchStart.click();h.relay('failed',undefined,{error:'Connection failed'});
 assert.match(h.nodes.signupBatchStatus.textContent,/Batch stopped/);
 h.relay('status',undefined,{status:'wizard_open',message:'Retrying the same page'});
 assert.equal(h.nodes.signupStart.disabled,true);assert.equal(h.nodes.signupStatus.textContent,'Retrying the same page');
 h.relay('verified');assert.match(h.nodes.signupStatus.textContent,/saved locally/);
 assert.equal(h.nodes.signupStart.disabled,false);assert.equal(h.allocations(),1);
 h.relay('status',undefined,{status:'awaiting_otp'});assert.equal(h.nodes.signupStart.disabled,false);
});

test('a failed browser launch releases extension ownership without discarding the saved signup',async()=>{
 const h=batchPanel({failDrive:true});await h.nodes.signupBatchStart.click();
 assert.equal(h.bodies.length,1);assert.equal(h.allocations(),1);
 assert.equal(h.calls.filter(c=>c.type==='epicgen-cancel').length,1);
 assert.match(h.nodes.signupBatchStatus.textContent,/Batch stopped/);
 assert.equal(h.nodes.signupStart.disabled,false);
});

test('an open signup prevents recovery before the original bearer can be rotated',async()=>{
 const nodes={},requests=[],listeners=new Set();
 for(const id of ['signupStatus','signupStart','signupCancel','signupResume','signupRecover','signupProxy','signupAuto','signupSession'])nodes[id]={textContent:'',checked:false,disabled:false,value:'',addEventListener(type,fn){this[type]=fn;}};
 const window={addEventListener:(t,fn)=>listeners.add(fn),removeEventListener:(t,fn)=>listeners.delete(fn),postMessage(msg){for(const fn of [...listeners])fn({source:window,origin:'http://local',data:{type:msg.type+'-ack',ok:msg.type!=='epicgen-allocate',error:'A signup is already active',payload:{version:'1.5.1'}}});}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{document:{getElementById:id=>nodes[id],querySelector:()=>null},window,location:{origin:'http://local'},setTimeout,clearTimeout,fetch:async route=>{requests.push(route);return{ok:true,json:async()=>({success:true,sessions:[{sessionId:'original',email:'same@example.com',status:'failed'}]})};}});
 await nodes.signupRecover.click();assert.equal(requests.some(r=>r.endsWith('/resume')),false);
 assert.match(nodes.signupStatus.textContent,/already active/);
});
