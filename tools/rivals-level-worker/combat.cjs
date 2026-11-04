'use strict';
const fs=require('node:fs'),path=require('node:path');
const {outlinedEnemies,excludeFriendlyNameplates}=require('./perception.cjs');
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function aim(target){
  const aligned=Math.abs(target.x-.5)<Math.max(.018,target.width*.4)&&Math.abs(target.y-.5)<.04;
  return {command:'controls',keys:[],milliseconds:aligned?250:80,dx:aligned?0:Math.round(clamp((target.x-.5)*400,-140,140)),dy:aligned?0:Math.round(clamp((target.y-.5)*400,-90,90)),fire:aligned};
}
async function track({driver,target,seed,reference,directory,prefix,guard,record,now=Date.now,deadline=Infinity}){
  const end=Math.min(now()+2200,deadline);let previous=seed,actions=0;
  for(let n=0;n<4&&now()<end;n++){
    guard();const output=path.join(directory,prefix+'-combat-'+n+'.png');
    const frame=await driver.request({...target,command:'capture',ocr:false,maxWidth:1280,output});guard();
    if(frame.frontmostPid!==target.pid||!Number.isFinite(Date.parse(frame.capturedAt))||now()-Date.parse(frame.capturedAt)>1000)break;
    if(frame.width!==1280||frame.lines.length)throw Error('Fast combat requires the current raw-capture driver');
    const sharp=require('sharp'),{data,info}=await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const enemies=excludeFriendlyNameplates(outlinedEnemies(data,info.width,info.height),data,info.width,info.height,reference.lines)
      .filter(t=>Math.hypot(t.x-previous.x,t.y-previous.y)<.2).sort((a,b)=>Math.hypot(a.x-previous.x,a.y-previous.y)-Math.hypot(b.x-previous.x,b.y-previous.y));
    const enemy=enemies[0];if(!enemy){fs.writeFileSync(output+'.json',JSON.stringify({...frame,enemies,action:null,reason:'Observed target lost; returning to full perception'}),{mode:0o600});break;}
    const action=aim(enemy);if(now()+action.milliseconds>=end||now()-Date.parse(frame.capturedAt)>1000)break;
    guard();await driver.request({...target,...action,expectedBounds:frame.window.bounds});
    fs.writeFileSync(output+'.json',JSON.stringify({...frame,enemies,target:enemy,action}),{mode:0o600});
    record?.({output,capturedAt:frame.capturedAt,action,target:enemy});previous=enemy;actions++;
  }
  return actions;
}
module.exports={aim,track};
