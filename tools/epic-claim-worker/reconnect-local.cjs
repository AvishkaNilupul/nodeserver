// Reconnect existing unsold accounts using the encrypted local vault.
// Credentials and one-time codes travel only through localhost and SSH stdin.
const path=require('path'),os=require('os');
const root=path.resolve(__dirname,'../..'),req=require('module').createRequire(root+'/package.json');
const fs=require('fs'),crypto=require('crypto'),{spawnSync}=require('child_process'),axios=req('axios');
const httpAgent=new (require('http').Agent)({keepAlive:false});
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
const env=req('dotenv').parse(fs.readFileSync(path.join(os.homedir(),'epic-claim','.env')));
const directory=path.join(os.homedir(),'Library','Application Support','EpicAccountGenerator');
const saved=JSON.parse(fs.readFileSync(directory+'/accounts.vault'));
const d=crypto.createDecipheriv('aes-256-gcm',fs.readFileSync(directory+'/vault.key'),Buffer.from(saved.iv,'base64'));d.setAuthTag(Buffer.from(saved.tag,'base64'));
const vault=JSON.parse(Buffer.concat([d.update(Buffer.from(saved.data,'base64')),d.final()]).toString());
function remote(script,input) {
 const quoted="'"+script.replace(/'/g,"'\\''")+"'";
 const r=spawnSync('ssh',['-i',path.join(os.homedir(),'.ssh','claude_prod_deploy_ed25519'),'-o','ConnectTimeout=10','root@202.92.214.91','cd /var/www/redeemer/nodeserver && node -e '+quoted],{input:input?JSON.stringify(input):undefined,encoding:'utf8',timeout:90000});
 if(r.status!==0)throw Error('Server account operation failed');return JSON.parse(r.stdout.trim());
}
const common="require('dotenv').config({quiet:true});const m=require('mongoose');";
const inspect=common+`(async()=>{try{await m.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});const rows=await require('./models/EpicAccount').find({sold:false});const results=[];for(const a of rows){let valid=true;try{await require('./utils/epicAccountToken').accountAccessToken(a);}catch{valid=false;}results.push({accountId:a.accountId,name:a.displayName,valid});}console.log(JSON.stringify(results));}finally{await m.disconnect();}})().catch(()=>process.exitCode=1);`;
const save=common+`(async()=>{try{const input=JSON.parse(require('fs').readFileSync(0,'utf8'));if(!/^[a-f\\d]{32}$/i.test(input.code)||!/^[a-f\\d]{32}$/i.test(input.accountId))throw Error();await m.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});const C=m.connection.db.collection('epicaccounts'),a=await C.findOne({accountId:input.accountId,sold:false});if(!a)throw Error();const tok=await require('./utils/epicClient').exchangeAuthCode(input.code);if(tok.account_id!==a.accountId)throw Error();const result=await C.updateOne({_id:a._id,refreshToken:a.refreshToken},{$set:{refreshToken:require('./utils/secretBox').encrypt(tok.refresh_token),refreshExpiresAt:new Date(tok.refresh_expires_at),status:'ok',lastError:'',updatedAt:new Date()}});if(result.matchedCount!==1)throw Error();console.log(JSON.stringify({saved:true,name:a.displayName}));}finally{await m.disconnect();}})().catch(()=>process.exitCode=1);`;
(async()=>{
 const first=remote(inspect);const targets=first.filter(a=>!a.valid);emit({phase:'recovery-start',accounts:targets.map(a=>a.name)});
 const recovered=[];
 const protectedAccounts=new Set(first.filter(a=>a.valid).map(a=>a.accountId));
 for(const target of targets){
  const local=vault.accounts.find(a=>a.accountId===target.accountId);
  if(!local?.email||!local.password){emit({phase:'credentials-unavailable',account:target.name});continue;}
  emit({phase:'signing-in',account:target.name});
  const response=await axios.post('http://127.0.0.1:8123/recover',{accountKey:target.accountId,displayName:target.name,email:local.email,password:local.password},{headers:{Authorization:'Bearer '+env.CLAIM_WORKER_TOKEN},timeout:260000,httpAgent,validateStatus:()=>true});
  if(response.data.status!=='reauthorized'){emit({phase:'needs-attention',account:target.name,status:response.data.status,error:response.data.error||''});break;}
  const result=remote(save,{accountId:target.accountId,code:response.data.code});recovered.push(target.accountId);emit({phase:'reconnected',account:result.name});
  const checked=remote(inspect);const lost=checked.filter(a=>(protectedAccounts.has(a.accountId)||recovered.includes(a.accountId))&&!a.valid);
  if(lost.length){emit({phase:'session-isolation-failed',accounts:lost.map(a=>a.name)});break;}
  emit({phase:'tokens-verified',recovered:recovered.length});
 }
 const final=remote(inspect);emit({phase:'recovery-finished',valid:final.filter(a=>a.valid).map(a=>a.name),remaining:final.filter(a=>!a.valid).map(a=>a.name)});
})().catch(e=>{emit({phase:'recovery-error',error:e.message==='Server account operation failed'?e.message:e.code||e.name});process.exitCode=1;});
