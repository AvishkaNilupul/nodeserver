const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
test('an unavailable server is explained before any Outlook reservation or extension action',async()=>{
 const nodes={};for(const id of ['signupStatus','signupStart','signupCancel','signupResume','signupRecover'])nodes[id]={textContent:'',disabled:false,addEventListener(type,fn){this[type]=fn;}};
 let extensionCalls=0;
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-signup-panel.js'),'utf8'),{
  document:{getElementById:id=>nodes[id]},window:{addEventListener(){},postMessage(){extensionCalls++;}},fetch:async()=>{throw TypeError('Failed to fetch');},setTimeout,clearTimeout,location:{origin:'https://panel.test'},
 });
 await nodes.signupStart.click();assert.equal(extensionCalls,0);assert.match(nodes.signupStatus.textContent,/Cannot reach the signup server/);assert.equal(nodes.signupStart.disabled,false);
});
