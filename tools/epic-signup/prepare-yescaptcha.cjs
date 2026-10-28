// Preparation only. Chrome installation and private-window access happen in UI.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{execFileSync}=require('child_process');
const {VERSION,SHA256,configure}=require('./yescaptcha-config.cjs');
async function prepare({settingsRoot=path.resolve(__dirname,'../..')}={}){
 require('dotenv').config({quiet:true,path:path.join(settingsRoot,'.env')});
 const config=require(path.join(settingsRoot,'utils/discordFarm/solverAdapter')).resolveSolverConfig();
 if(config.provider!=='yescaptcha')throw Error('Existing provider is not YesCaptcha');
 const root=path.join(os.homedir(),'Library/Application Support/EpicAccountGenerator');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const dest=path.join(root,'yescaptcha-assistant-'+VERSION);
 if(fs.existsSync(dest))throw Error('Companion folder already exists; keep its installed configuration intact');
 const temp=fs.mkdtempSync(path.join(root,'.yescaptcha-'));fs.chmodSync(temp,0o700);
 try{
  const r=await fetch('https://docs.yescaptcha.com/downloads/yescaptcha-assistant-chrome-'+VERSION+'.zip',{signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error('Official companion download failed');
  const bytes=Buffer.from(await r.arrayBuffer());
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==SHA256)throw Error('Official package checksum changed; inspect before updating');
  const zip=path.join(temp,'package.zip');fs.writeFileSync(zip,bytes,{mode:0o600});
  const names=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n');
  if(names.some(n=>n.startsWith('/')||n.split('/').includes('..')))throw Error('Invalid companion archive');
  const extracted=path.join(temp,'extension');fs.mkdirSync(extracted,{mode:0o700});
  execFileSync('unzip',['-q',zip,'-d',extracted]);
  const manifest=JSON.parse(fs.readFileSync(path.join(extracted,'manifest.json'),'utf8'));
  if(manifest.version!==VERSION)throw Error('Companion version mismatch');
  const file=path.join(extracted,'config.js');fs.writeFileSync(file,configure(fs.readFileSync(file,'utf8'),config.apiKey),{mode:0o600});fs.chmodSync(file,0o600);
  fs.renameSync(extracted,dest);fs.chmodSync(dest,0o700);
  return{path:dest,version:VERSION,keyConfigured:true,scope:'epicgames.com',maxRecognitionFlows:8};
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(require.main===module)prepare({settingsRoot:process.argv[2]||undefined}).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('YesCaptcha preparation failed. Check the existing local solver configuration and official package.');process.exitCode=1;});
module.exports={prepare};
