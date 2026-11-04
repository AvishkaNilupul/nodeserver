'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),crypto=require('node:crypto');
const revision='cfef6f6f2a70783dedc0bfae40cecbc2052285d3',repository='apple/coreml-depth-anything-v2-small',name='DepthAnythingV2SmallF16.mlpackage';
async function setup(root=process.env.RIVALS_LEVEL_DIR||path.join(os.homedir(),'Library/Application Support/RivalsLevelWorker')){
  fs.mkdirSync(root,{recursive:true,mode:0o700});const files={};
  for(const relative of ['Manifest.json','Data/com.apple.CoreML/model.mlmodel','Data/com.apple.CoreML/weights/weight.bin']){
    const output=path.join(root,'models',name,relative);fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
    const response=await fetch(`https://huggingface.co/${repository}/resolve/${revision}/${name}/${relative}`);
    if(!response.ok)throw Error('Depth model download failed: '+response.status);
    const data=Buffer.from(await response.arrayBuffer());fs.writeFileSync(output,data,{mode:0o600});files[relative]={bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
  }
  const result=spawnSync('swiftc',[path.join(__dirname,'depth.swift'),'-o',path.join(root,'depth-native')],{stdio:'inherit'});
  if(result.status!==0)throw Error('Depth helper compile failed');
  fs.writeFileSync(path.join(root,'models','depth-provenance.json'),JSON.stringify({repository,revision,license:'Apache-2.0',files},null,2),{mode:0o600});
  console.log(JSON.stringify({ok:true,model:path.join(root,'models',name)}));
}
if(require.main===module)setup().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={setup};
