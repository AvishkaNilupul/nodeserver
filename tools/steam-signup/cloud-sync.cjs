// Upload queue for finished Steam accounts. Same design as the Epic generator's
// queue (tools/epic-signup/cloud-sync.cjs), kept separate so neither tool can
// break the other: saved locally first, retried with back-off, state kept on
// each vault account as `cloud`. The transport runs
// tools/steam-signup/cloud-import.cjs on the server over the existing deploy
// SSH key, with the account on stdin. Contract: docs/STEAM-ACCOUNTS.md.
// The server address lives in cloud.json in the generator's data folder (on the
// Mac only, never in git): {"host":"user@host","remoteRoot":"/path/to/app"}.
const {spawn}=require('child_process'),path=require('path'),os=require('os'),fs=require('fs');

function loadCloudTarget(dataDir){
  try{const t=JSON.parse(fs.readFileSync(path.join(dataDir,'cloud.json'),'utf8'));if(typeof t.host==='string'&&typeof t.remoteRoot==='string')return{host:t.host,remoteRoot:t.remoteRoot};}catch{}
  return null;
}

function steamPayload(a){
  return {version:1,account:{
    localId:a.id,accountName:a.username,password:a.password,email:a.email,
    signupCountry:a.country||null,requestedCountry:a.requestedCountry||null,
    proxyCountry:a.creationLocation?.country||null,proxyCity:a.creationLocation?.city||'',
    signedUpAt:a.completedAt||a.createdAt||null,
  }};
}

function createSteamSshUploader({host,keyFile=path.join(os.homedir(),'.ssh','claude_prod_deploy_ed25519'),remoteRoot,spawnProcess=spawn}={}) {
  if(!/^[a-z0-9@.:-]+$/i.test(host||''))throw Error('Invalid cloud host');
  if(!/^\/[A-Za-z0-9._\/-]+$/.test(remoteRoot||''))throw Error('Invalid remote path');
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  return account=>new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',['-i',keyFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',host,'cd '+quote(remoteRoot)+' && node tools/steam-signup/cloud-import.cjs'],{stdio:['pipe','pipe','pipe'],timeout:45000});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>reject(Error('Server upload unavailable')));
    child.on('close',code=>{try{const data=JSON.parse(output.trim());if(code!==0||!data.success||data.localId!==account.id||!data.cloudId)throw Error();resolve(data);}catch{reject(Error('Server upload unavailable'));}});
    child.stdin.end(JSON.stringify(steamPayload(account)));
  });
}

class CloudSync {
  constructor({vault,upload,now=Date.now}){this.vault=vault;this.upload=upload;this.now=now;this.running=false;}
  enqueue(account,{force=false}={}) {
    if(account.cloud?.state==='uploaded')return;
    account.cloud={...account.cloud,state:'pending',nextAttemptAt:force?0:(account.cloud?.nextAttemptAt||0)};this.vault.save();
  }
  async runDue(){
    if(this.running)return;this.running=true;
    try{for(const a of this.vault.data.accounts){
      if(!a.cloud||a.cloud.state==='uploaded'||(a.cloud.nextAttemptAt||0)>this.now())continue;
      a.cloud.state='uploading';a.cloud.attempts=(a.cloud.attempts||0)+1;this.vault.save();
      try{const result=await this.upload(a);a.cloud={...a.cloud,state:'uploaded',cloudId:result.cloudId,uploadedAt:new Date(this.now()).toISOString(),lastError:'',nextAttemptAt:0};}
      catch{a.cloud={...a.cloud,state:'pending',lastError:'Server unavailable; saved here and queued for retry.',nextAttemptAt:this.now()+Math.min(1800000,30000*2**Math.min(a.cloud.attempts-1,6))};}
      this.vault.save();
    }}finally{this.running=false;}
  }
  wake(){setImmediate(()=>this.runDue().catch(()=>{}));}
  // An account left "uploading" by a crash or restart goes back in the queue.
  start(){for(const a of this.vault.data.accounts){if(a.cloud?.state==='uploading')a.cloud.state='pending';this.enqueue(a);}this.wake();this.timer=setInterval(()=>this.runDue().catch(()=>{}),15000);this.timer.unref();}
  stop(){clearInterval(this.timer);}
}

module.exports={CloudSync,createSteamSshUploader,steamPayload,loadCloudTarget};
