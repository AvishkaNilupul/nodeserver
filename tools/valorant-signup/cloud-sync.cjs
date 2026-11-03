const {spawn}=require('child_process'),path=require('path'),os=require('os');
const {loadCloudTarget}=require('../steam-signup/cloud-sync.cjs');
function payload(session){return {version:1,account:{localId:session.id,accountName:session.username,password:session.password,email:session.email,
  birthDate:session.birthDate,status:session.status,requestedCountry:session.requestedCountry,
  proxyCountry:session.creationLocation.country,expectedShard:session.expectedShard,completedAt:session.completedAt||null}};}
function createUploader({host,remoteRoot,keyFile=path.join(os.homedir(),'.ssh','claude_prod_deploy_ed25519'),spawnProcess=spawn}){
  if(!/^[a-z0-9@.:-]+$/i.test(host||'')||!/^\/[a-z0-9._/-]+$/i.test(remoteRoot||''))throw Error('Invalid server target');
  return session=>new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',['-i',keyFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',host,
      "cd '"+remoteRoot+"' && node tools/valorant-signup/cloud-import.cjs"],{stdio:['pipe','pipe','pipe'],timeout:45000});
    let output='';child.stdout.on('data',b=>{output+=b;if(output.length>16384)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>reject(Error('Site upload unavailable')));child.on('close',code=>{
      try{const d=JSON.parse(output.trim());if(code!==0||!d.success||d.localId!==session.id||!d.cloudId)throw Error();resolve(d);}catch{reject(Error('Site upload unavailable'));}
    });child.stdin.end(JSON.stringify(payload(session)));
  });
}
class CloudSync{
  constructor({vault,upload,now=Date.now}){Object.assign(this,{vault,upload,now});this.running=false;}
  async runDue(){
    if(this.running)return;this.running=true;
    try{for(const s of this.vault.data.sessions){
      if(!['reserved','created'].includes(s.status))continue;
      if(s.cloud?.syncedStatus===s.status||(s.cloud?.nextAttemptAt||0)>this.now())continue;
      const status=s.status;
      try{const r=await this.upload({...s,status});s.cloud={state:'uploaded',cloudId:r.cloudId,syncedStatus:status,uploadedAt:new Date(this.now()).toISOString(),nextAttemptAt:0};}
      catch{s.cloud={...s.cloud,state:'pending',lastError:'Saved here; site upload will retry.',nextAttemptAt:this.now()+60000};}
      const account=this.vault.data.accounts.find(a=>a.id===s.id);if(account)account.cloud=s.cloud;
      this.vault.save();
    }}finally{this.running=false;}
  }
  start(){this.runDue().catch(()=>{});this.timer=setInterval(()=>this.runDue().catch(()=>{}),15000);this.timer.unref();}
  stop(){clearInterval(this.timer);}
}
module.exports={CloudSync,createUploader,loadCloudTarget,payload};
