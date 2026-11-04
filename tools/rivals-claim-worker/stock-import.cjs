const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {Queue}=require('./queue.cjs');
function transport({request,target,keyFile=path.join(os.homedir(),'.ssh/claude_prod_deploy_ed25519'),spawnProcess=spawn}){
 if(!/^[a-z0-9@.:-]+$/i.test(target?.host||'')||!/^\/[A-Za-z0-9._\/-]+$/.test(target?.remoteRoot||''))throw Error('Invalid server target');
 const safety=fs.readFileSync(path.join(__dirname,'stock-safety.cjs'),'utf8');
 const remote=fs.readFileSync(path.join(__dirname,'remote-stock.cjs'),'utf8');
 const program=`const SAFETY=(()=>{const module={exports:{}};${safety};return module.exports;})();\nconst REMOTE=(()=>{const module={exports:{}};${remote};return module.exports;})();\nREMOTE.runRemote(${JSON.stringify(request)},SAFETY).then(x=>console.log(JSON.stringify({ok:true,result:x}))).catch(e=>{const safe=/^(Stock evidence|Steam account|Steam booster|Twitch login|Twitch account|Twitch pool|Live Twitch|No unlinked|No live sellable|Selected account|Existing preparation|Preparation hold|Stock was taken|A concurrent|Steam hold changed)/.test(e.message||'');console.log(JSON.stringify({ok:false,error:safe?e.message:'Stock hold could not be verified. Inspect the preparation record before retrying.'}));process.exitCode=1;});`;
 return new Promise((resolve,reject)=>{
  const child=spawnProcess('ssh',['-i',keyFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15',target.host,'cd '+target.remoteRoot+' && node -'],{stdio:['pipe','pipe','pipe'],timeout:90000});
  let output='';child.stdout.on('data',c=>{output+=c;if(output.length>200000)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>reject(Error('Server transport unavailable')));
  child.on('close',code=>{let p;try{p=JSON.parse(output.trim());}catch{return reject(Error('Stock hold failed. Preserve account holds and inspect the preparation record.'));}if(code!==0||!p.ok)return reject(Error('Stock hold refused: '+String(p.error||'Unknown state').slice(0,180)));resolve(p.result);});
  child.stdin.end(program);
 });
}
if(require.main===module)(async()=>{
 let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>4096)throw Error('Input too large');}
 const request=JSON.parse(raw),target=JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/SteamAccountGenerator/cloud.json'),'utf8'));
 const pair=await transport({request:process.argv.includes('--prepare')?{...request,action:'prepare'}:request,target});
 if(process.argv.includes('--prepare')){console.log(JSON.stringify({ok:true,result:pair}));return;}
 const q=new Queue(process.env.RIVALS_WORKER_DIR||path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker'));
 const job=q.import(pair);console.log(JSON.stringify({ok:true,job}));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:e.message.startsWith('Stock hold refused:')?e.message:'Canary import failed; preserve remote holds and inspect their state before retrying.'}));process.exitCode=1;});
module.exports={transport};
