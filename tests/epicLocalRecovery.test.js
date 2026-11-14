const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLocalApp}=require('../tools/epic-signup/local-app.cjs');
test('unfinished local identity survives bearer expiry and a new signup, while old callbacks stay rejected',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epic-recovery-test-'));
 const {app,vault,uiToken}=createLocalApp({dataDir:dir,port:4107});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 function post(route,body,token){return new Promise((resolve,reject)=>{
  const request=require('node:http').request(base+route,{method:'POST',headers:{Host:'127.0.0.1:4107','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{'X-Local-Token':uiToken})}},res=>{
   let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,...JSON.parse(text)});}catch(e){reject(e);}});
  });request.on('error',reject);request.end(JSON.stringify(body));
 });}
 const mailbox=address=>({address,provider:'outlook-local',reservedAt:new Date().toISOString()});
 const original=(await post('/api/epic/signup/start',{mailbox:mailbox('first@outlook.com')})).session;
 const expired=vault.data.sessions.find(s=>s.sessionId===original.sessionId);expired.expiresAt='2000-01-01T00:00:00Z';expired.status='failed';vault.save();
 const statusRoute='/api/epic/signup/'+original.sessionId+'/status';
 assert.equal((await post(statusRoute,{status:'awaiting_otp'},original.bearer)).status,401);
 await post('/api/epic/signup/start',{mailbox:mailbox('second@outlook.com')});
 assert.equal(vault.data.sessions.length,2);
 const resumed=await post('/api/epic/signup/'+original.sessionId+'/resume',{mode:'login'});
 assert.equal(resumed.status,200);assert.equal(resumed.session.login,true);
 assert.deepEqual(resumed.session.identity,original.identity);assert.notEqual(resumed.session.bearer,original.bearer);
 assert.equal((await post(statusRoute,{status:'awaiting_otp'},original.bearer)).status,401);
 assert.equal((await post(statusRoute,{status:'awaiting_otp'},resumed.session.bearer)).status,200);
 assert.ok(Date.parse(vault.data.sessions[0].expiresAt)>Date.now());
 assert.equal(fs.readFileSync(path.join(dir,'accounts.vault'),'utf8').includes(original.identity.password),false);
});
