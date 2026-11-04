'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),readline=require('node:readline');
const {Driver}=require('./driver.cjs');
const names=['w','a','s','d','e','q','r','f','v','shift','space','escape','return','tab','1','2','3','4','h','b'];
const windowsPath=p=>{if(typeof p!=='string'||!p.startsWith('/')||/[\r\n\0]/.test(p))throw Error('Absolute private input path required');return 'Z:'+p.replaceAll('/','\\');};
function escapeMenu(settings,ms){
 if(!Number.isInteger(ms)||ms<20||ms>3000)return Promise.reject(Error('Invalid bounded menu key'));
 return new Promise((resolve,reject)=>{
  const child=spawn(settings.wine,['--bottle',settings.bottle,'--no-gui','--no-update','--debugmsg','-all','--cx-app',windowsPath(settings.binary),windowsPath(settings.stopFile),windowsPath(settings.abortFile),'escape',String(ms)],{stdio:['ignore','pipe','pipe']});
  let output='';const timeout=setTimeout(()=>{child.kill();reject(Error('Menu input response timed out'));},ms+10000);
  child.stdout.on('data',c=>{output+=c;if(output.length>2048)child.kill();});child.stderr.on('data',()=>{});
  child.on('error',()=>{clearTimeout(timeout);reject(Error('Menu input unavailable'));});
  child.on('close',code=>{clearTimeout(timeout);try{const result=JSON.parse(output.trim());if(code!==0||!result.ok)throw Error(result.error??'Menu input failed');resolve(result);}catch(e){reject(e);}});
 });
}
class WineInput{
 constructor({wine,bottle,binary,stopFile,abortFile}){
  if(typeof bottle!=='string'||!bottle||bottle.length>80||/[\r\n\0]/.test(bottle))throw Error('Exact Wine bottle required');
  this.pending=[];this.closed=false;this.process=spawn(wine,['--bottle',bottle,'--no-gui','--no-update','--debugmsg','-all','--cx-app',windowsPath(binary),windowsPath(stopFile),windowsPath(abortFile)],{stdio:['pipe','pipe','pipe']});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.startup=setTimeout(()=>{this.rejectReady(Error('Wine input startup timed out'));this.process.kill();},15000);
  readline.createInterface({input:this.process.stdout}).on('line',line=>{
   try{const r=JSON.parse(line);if(r.ready){clearTimeout(this.startup);this.winPid=r.winPid;this.resolveReady(r);return;}
    const p=this.pending.shift();if(!p){clearTimeout(this.startup);this.rejectReady(Error(r.error??'Wine input startup failed'));return;}
    clearTimeout(p.timeout);r.ok?p.resolve(r):p.reject(Error(r.error));
   }catch(e){this.rejectReady(e);}
  });
  this.process.stderr.on('data',()=>{});this.process.stdin.on('error',()=>{});
  const close=()=>{clearTimeout(this.startup);this.closed=true;this.rejectReady(Error('Wine input stopped'));for(const p of this.pending.splice(0)){clearTimeout(p.timeout);p.reject(Error('Wine input stopped'));}};
  this.process.on('error',close);this.process.on('exit',close);
 }
 async command(line,timeout=6000){await this.ready;if(this.closed)throw Error('Wine input unavailable');return new Promise((resolve,reject)=>{const p={resolve,reject,timeout:setTimeout(()=>{reject(Error('Wine input response timed out'));this.process.kill();},timeout)};this.pending.push(p);this.process.stdin.write(line+'\n');});}
 async controls(p){
  const keys=p.keys??[],dx=p.dx??0,dy=p.dy??0,ms=p.milliseconds;
  if(!Array.isArray(keys)||keys.length>4||keys.some(k=>!names.includes(k)||k==='escape')||![dx,dy,ms].every(Number.isInteger)||Math.abs(dx)>400||Math.abs(dy)>250||ms<20||ms>3000)throw Error('Invalid bounded Wine controls');
  return this.command(`control ${dx} ${dy} ${ms} ${p.fire===true?1:0} ${keys.reduce((mask,k)=>mask|(1<<names.indexOf(k)),0)}`);
 }
 async close(){if(this.closed)return;try{await this.command('release');}finally{this.process.stdin.end();}}
}
class WineDriver{
 constructor(binary,{bottle,directoryRoot,wine='/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',nativeFactory=b=>new Driver(b),wineFactory=p=>new WineInput(p),menuFactory=escapeMenu}={}){
  this.native=nativeFactory(binary);this.root=directoryRoot;this.stopFile=path.join(directoryRoot,'STOP');this.abortFile=path.join(directoryRoot,'input-abort-'+crypto.randomUUID());this.settings={wine,bottle,binary:path.join(directoryRoot,'win-input.exe'),stopFile:this.stopFile,abortFile:this.abortFile};this.wineFactory=wineFactory;this.menuFactory=menuFactory;this.wine=null;
 }
 async request(p){
  if(p.command==='controls'&&(!Array.isArray(p.keys??[])||(p.keys??[]).length>4||(p.keys??[]).some(k=>!names.includes(k))||![p.dx??0,p.dy??0,p.milliseconds].every(Number.isInteger)||Math.abs(p.dx??0)>400||Math.abs(p.dy??0)>250||p.milliseconds<20||p.milliseconds>3000||p.fire!==undefined&&typeof p.fire!=='boolean'))throw Error('Invalid bounded controls');
  if(p.command==='focus'){const r=await this.native.request(p);if(!this.wine){this.wine=this.wineFactory(this.settings);await this.wine.ready;}return r;}
  if(p.command!=='controls')return this.native.request(p);
  const menu=(p.keys??[]).includes('escape');if(menu&&((p.keys??[]).length!==1||(p.dx??0)!==0||(p.dy??0)!==0||p.fire))throw Error('Escape is a separate bounded menu operation');
  await this.native.request({...p,command:'watch',keys:[],milliseconds:20});
  if(!this.wine){this.wine=this.wineFactory(this.settings);await this.wine.ready;await this.native.request({...p,command:'watch',keys:[],milliseconds:20});}
  let stopped=false;const abort=e=>{if(!stopped){stopped=true;fs.writeFileSync(this.abortFile,e.message,{mode:0o600});}throw e;};
  // The native watcher polls actual macOS focus/STOP/hotkey while Windows owns
  // keyboard and relative mouse input. A private abort file lets it release within 25ms on failure.
  let finished=false;
  const action=(menu?this.menuFactory(this.settings,p.milliseconds):this.wine.controls(p)).catch(abort).finally(()=>{finished=true;});
  const guard=(async()=>{do{await this.native.request({...p,command:'watch',abortFile:this.abortFile,keys:[],dx:0,dy:0,fire:false,milliseconds:menu?3000:p.milliseconds});}while(menu&&!finished);})().catch(abort);
  const results=await Promise.allSettled([action,guard]);
  if(fs.existsSync(this.abortFile))fs.unlinkSync(this.abortFile);
  const failure=results[1].status==='rejected'?results[1]:results.find(r=>r.status==='rejected');if(failure){failure.reason.backendResults=results.map(r=>r.status==='rejected'?r.reason.message:'ok');throw failure.reason;}
  return results[0].value;
 }
 async close(){try{if(this.wine)await this.wine.close();}finally{await this.native.close();if(fs.existsSync(this.abortFile))fs.unlinkSync(this.abortFile);}}
}
module.exports={WineInput,WineDriver,windowsPath,names,escapeMenu};
