const os=require('node:os'),path=require('node:path');
const {Queue}=require('./queue.cjs');
const directory=process.env.RIVALS_WORKER_DIR||path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker');
async function main(){
  const command=process.argv[2]||'status',q=new Queue(directory);
  let p={};if(command!=='status'){let s='';for await(const c of process.stdin){s+=c;if(Buffer.byteLength(s)>131072)throw Error('Input too large');}p=s?JSON.parse(s):{};}
  let result;
  switch(command){
    case 'status': result=q.status();break;
    case 'import': result=q.import(p);break;
    case 'acquire': result=q.acquire(p.owner,p.id);break;
    case 'observe': result=q.record(p.id,p.leaseToken,p.revision,p.observation);break;
    case 'heartbeat': result=q.heartbeat(p.id,p.leaseToken);break;
    case 'begin-login': result=q.beginLogin(p.id,p.leaseToken);break;
    case 'block': result=q.block(p.id,p.leaseToken,p.reason);break;
    case 'resume': result=q.resume(p.id);break;
    case 'pause': result=q.pause(false);break;
    case 'enable': result=q.pause(true);break;
    default: throw Error('Unknown command');
  }
  console.log(JSON.stringify({ok:true,result}));
}
if(require.main===module)main().catch(e=>{console.log(JSON.stringify({ok:false,error:e.status?e.message:'Worker command failed; private data was preserved'}));process.exitCode=1;});
module.exports={main};
