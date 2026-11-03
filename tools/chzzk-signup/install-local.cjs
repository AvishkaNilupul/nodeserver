const fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');
if(process.platform!=='darwin')throw Error('Run local-app.cjs directly on this platform');
const home=os.homedir(),scope='gui/'+process.getuid(),label='com.avishka.chzzk-account-generator';
const directory=path.join(home,'Library','LaunchAgents');fs.mkdirSync(directory,{recursive:true});
const xml=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const node=fs.existsSync('/opt/homebrew/bin/node')?'/opt/homebrew/bin/node':process.execPath;
const file=path.join(directory,label+'.plist');
if(spawnSync('launchctl',['print',scope+'/'+label],{stdio:'ignore'}).status===0){if(spawnSync('launchctl',['bootout',scope+'/'+label],{stdio:'inherit'}).status!==0)throw Error('Could not stop the old CHZZK service');}
if(fs.existsSync(file))fs.copyFileSync(file,file+'.backup-'+Date.now());
fs.writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(__dirname,'local-app.cjs'))}</string></array><key>WorkingDirectory</key><string>${xml(path.resolve(__dirname,'../..'))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(path.join(home,'Library','Logs','chzzk-local-generator.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home,'Library','Logs','chzzk-local-generator.log'))}</string></dict></plist>`);
let loaded=false;
// launchd can still be releasing the old registration immediately after bootout.
for(let attempt=0;attempt<3;attempt++){if(spawnSync('launchctl',['bootstrap',scope,file],{stdio:'ignore'}).status===0){loaded=true;break;}spawnSync('/bin/sleep',['0.3']);}
if(!loaded)throw Error('Could not start the CHZZK generator; retry the installer after launchd releases its previous registration');
console.log('CHZZK generator installed: http://127.0.0.1:4109');
