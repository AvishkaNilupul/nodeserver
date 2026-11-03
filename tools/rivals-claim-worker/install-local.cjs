const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
if(process.platform!=='darwin')throw Error('Use server.cjs directly outside macOS');
const dir=path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker'),runtime=path.join(dir,'runtime');
fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const files=['store.cjs','queue.cjs','server.cjs','guard.cjs','index.html','app.js','style.css'];
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup=path.join(dir,'runtime-backup-'+stamp);
for(const name of files){const to=path.join(runtime,name);if(fs.existsSync(to)){fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.copyFileSync(to,path.join(backup,name));}fs.copyFileSync(path.join(__dirname,name),to);}
const label='com.avishka.rivals-claim-worker',scope='gui/'+process.getuid(),agents=path.join(os.homedir(),'Library/LaunchAgents');
fs.mkdirSync(agents,{recursive:true});const plist=path.join(agents,label+'.plist');
const xml=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const node=fs.existsSync('/opt/homebrew/bin/node')?'/opt/homebrew/bin/node':process.execPath;
if(spawnSync('launchctl',['print',scope+'/'+label],{stdio:'ignore'}).status===0&&spawnSync('launchctl',['bootout',scope+'/'+label],{stdio:'ignore'}).status!==0)throw Error('Existing claim desk could not stop');
if(fs.existsSync(plist))fs.copyFileSync(plist,plist+'.backup-'+stamp);
const log=path.join(dir,'service.log');
fs.writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(runtime,'server.cjs'))}</string></array><key>WorkingDirectory</key><string>${xml(runtime)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,{mode:0o600});
let ok=false;for(let i=0;i<3;i++){if(spawnSync('launchctl',['bootstrap',scope,plist],{stdio:'ignore'}).status===0){ok=true;break;}spawnSync('/bin/sleep',['0.3']);}
if(!ok)throw Error('Claim desk could not start; saved account data is untouched');
console.log('Installed Rivals claim desk: http://127.0.0.1:4112');
