const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
function uploader(directory){
  let c;try{c=JSON.parse(fs.readFileSync(path.join(directory,'cloud.json'),'utf8'));}catch{return null;}
  if(!/^[\w@.:-]+$/.test(c.host||'')||!/^\/[\w./-]+$/.test(c.remoteRoot||''))throw Error('Invalid cloud settings');
  return a=>new Promise((resolve,reject)=>{
    const proc=spawn('ssh',['-i',path.join(os.homedir(),'.ssh','claude_prod_deploy_ed25519'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',c.host,"cd '"+c.remoteRoot+"' && node tools/chzzk-signup/cloud-import.cjs"],{stdio:['pipe','pipe','pipe'],timeout:60000});
    let out='';proc.stdout.on('data',x=>{out+=x;if(out.length>65536)proc.kill();});proc.stderr.resume();proc.stdin.on('error',()=>{});
    proc.on('error',()=>reject(Error('Upload unavailable')));proc.on('close',code=>{try{const r=JSON.parse(out.trim());if(code||!r.success||r.localId!==a.id||!r.cloudId)throw Error();resolve(r);}catch{reject(Error('Upload unavailable'));}});
    proc.stdin.end(JSON.stringify({version:1,localId:a.id,userIdHash:a.userIdHash,cookies:a.cookies}));
  });
}
class Queue {
  constructor(vault,upload){this.vault=vault;this.upload=upload;this.busy=false;}
  async run(){if(!this.upload||this.busy)return;this.busy=true;try{for(const a of this.vault.data.accounts){
    if(a.cloud?.state==='uploaded'||(a.cloud?.nextAttemptAt||0)>Date.now())continue;
    try{const r=await this.upload(a);a.cloud={state:'uploaded',cloudId:r.cloudId,uploadedAt:new Date().toISOString()};}
    catch{const attempts=(a.cloud?.attempts||0)+1;a.cloud={state:'pending',attempts,nextAttemptAt:Date.now()+Math.min(1800000,30000*2**Math.min(attempts-1,6))};}
    this.vault.save();
  }}finally{this.busy=false;}}
  start(){this.timer=setInterval(()=>this.run().catch(()=>{}),15000);this.timer.unref();this.run().catch(()=>{});}
  stop(){clearInterval(this.timer);}
}
module.exports={uploader,Queue};
