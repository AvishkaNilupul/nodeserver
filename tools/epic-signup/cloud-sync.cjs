const {spawn}=require('child_process'),path=require('path'),os=require('os');
function createSshUploader({host='root@202.92.214.91',keyFile=path.join(os.homedir(),'.ssh','claude_prod_deploy_ed25519'),remoteRoot='/var/www/redeemer/nodeserver',spawnProcess=spawn}={}) {
  if(!/^[a-z0-9@.:-]+$/i.test(host))throw Error('Invalid cloud host');
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  return account=>new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',['-i',keyFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',host,'cd '+quote(remoteRoot)+' && node tools/epic-signup/cloud-import.cjs'],{stdio:['pipe','pipe','pipe'],timeout:45000});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>reject(Error('Cloud upload unavailable')));
    child.on('close',code=>{try{const data=JSON.parse(output.trim());if(code!==0||!data.success||data.accountId!==account.accountId||!data.cloudId)throw Error();resolve(data);}catch{reject(Error('Cloud upload unavailable'));}});
    const payload={version:1,account:Object.fromEntries(['accountId','displayName','email','password','totpSecret','refreshToken','refreshExpiresAt','profile'].map(k=>[k,account[k]]))};
    child.stdin.end(JSON.stringify(payload));
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
      catch{a.cloud={...a.cloud,state:'pending',lastError:'Cloud unavailable; saved locally and queued for retry.',nextAttemptAt:this.now()+Math.min(1800000,30000*2**Math.min(a.cloud.attempts-1,6))};}
      this.vault.save();
    }}finally{this.running=false;}
  }
  wake(){setImmediate(()=>this.runDue().catch(()=>{}));}
  start(){for(const a of this.vault.data.accounts)this.enqueue(a);this.wake();this.timer=setInterval(()=>this.runDue().catch(()=>{}),15000);this.timer.unref();}
  stop(){clearInterval(this.timer);}
}
module.exports={CloudSync,createSshUploader};
