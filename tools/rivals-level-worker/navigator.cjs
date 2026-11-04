'use strict';
const {corridors}=require('./perception.cjs');
const {center,normalize,worldDistance,worldObjective}=require('./vision.cjs');
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const control=(keys,milliseconds,extra={})=>({command:'controls',keys,milliseconds,...extra});
class Navigator{
  constructor(){this.target=null;this.lastTargetAt=0;this.lastDistance=null;this.bestDistance=null;this.progressAt=null;this.detours=0;this.detourUntil=0;this.detourSide='a';this.shots=0;this.lastGoal=null;this.lastGoalAt=0;this.lastTurn=0;this.lastTurnAt=0;this.groundSearch=0;this.exploreSteps=0;this.spawnAt=null;this.leftSpawn=false;this.portalWalked=false;this.pendingTurn=false;this.pitchDelta=0;}
  reset(){Object.assign(this,new Navigator());}
  step(frame,hints,now){
    this.spawnAt??=now;
    if(hints.stalled){this.detourUntil=0;this.exploreSteps=0;this.detours++;this.detourSide=this.detours%2?'a':'d';return {action:control([this.detourSide,'space'],1200,{dx:this.detourSide==='a'?-50:50}),reason:'Scene stalled at an obstacle; trying the side passage'};}
    const hp=frame.lines.find(l=>l.x>.4&&l.x<.65&&l.y>.8&&/^\d+\s*\/\s*300$/.test(l.text));
    const health=hp?Number(hp.text.split('/')[0].trim()):null;
    if(health===0)return {wait:true,reason:'Waiting for respawn'};
    const ammo=frame.lines.find(l=>l.x<.3&&l.y>.85&&/\b\d+\s*\/\s*4/.test(l.text));
    const rounds=ammo?Number(ammo.text.match(/(\d+)\s*\/\s*4/)[1]):null;
    const threats=(hints.enemies??[]).filter(t=>t.x>.08&&t.x<.93&&t.y>.18&&t.y<.75);
    threats.sort((a,b)=>{
      const score=t=>Math.hypot(t.x-.5,t.y-.5)-(t.source==='enemy-nameplate'?.2:0)-(this.target&&Math.hypot(t.x-this.target.x,t.y-this.target.y)<.1?.08:0);
      return score(a)-score(b);
    });
    const enemy=threats[0];
    if(rounds===0)return {action:control([enemy?'a':'w','r'],1000),reason:'Reloading empty rifle'};
    if(enemy){
      this.leftSpawn=true;this.target=enemy;this.lastTargetAt=now;this.shots++;
      const dx=Math.round(clamp((enemy.x-.5)*400,-140,140)),dy=Math.round(clamp((enemy.y-.5)*400,-90,90));
      const aligned=Math.abs(enemy.x-.5)<Math.max(.012,enemy.width*.3)&&Math.abs(enemy.y-.5)<.035;
      // Observe the correction before firing. Moving forward while aligning
      // changed target bearing and caused overshoot in the actual range.
      if(!aligned){this.pitchDelta+=dy;return {action:control([],450,{dx,dy}),reason:'Aligning on visible enemy',target:enemy};}
      const keys=health!==null&&health<80?['s']:[];
      return {action:control(keys,650,{dx:0,dy:0,fire:true}),reason:'Firing at the observed aligned enemy',target:enemy};
    }
    this.target=null;
    const portal=(hints.exits??[]).filter(p=>p.x>.1&&p.x<.9).sort((a,b)=>Math.abs(a.x-.5)-Math.abs(b.x-.5))[0];
    if(!portal&&this.portalWalked)this.leftSpawn=true;
    if(portal&&!this.leftSpawn&&now-this.spawnAt<90000){
      const dx=Math.round(clamp((portal.x-.5)*400,-140,140));
      if(Math.abs(portal.x-.5)>.04)return {action:control([],350,{dx}),reason:'Aligning with the visible green spawn exit',target:portal};
      this.portalWalked=true;return {action:control(['w'],2200),reason:'Leaving through the visible spawn exit',target:portal};
    }
    const marker=worldObjective(frame);
    const distance=worldDistance(frame);
    const arrow=(hints.navigationMarkers??[])[0];
    if(arrow&&now>=this.detourUntil)return {action:control([],350,{dx:(arrow.bearing==='left'?-1:1)*(arrow.behind?300:120)}),reason:arrow.behind?'Turning back toward the objective behind the camera':'Turning toward the visible offscreen objective arrow',target:arrow};
    let goal=marker?center(marker):distance?{x:distance.x+distance.width/2,y:distance.y-.035}:null;
    const teammate=frame.lines.filter(l=>l.y>.2&&l.y<.7&&l.x>.1&&l.x<.9&&(hints.teamNames??[]).some(name=>normalize(name)===normalize(l.text))).sort((a,b)=>Math.abs(a.x-.5)-Math.abs(b.x-.5))[0];
    if(!goal&&teammate)goal={...center(teammate),y:teammate.y+.05};
    if(goal){this.lastGoal=goal;this.lastGoalAt=now;}
    else if(now-this.lastGoalAt<8000)goal=this.lastGoal;
    if(now<this.detourUntil)return {action:control([this.detourSide],1400),reason:'Following the clearer side of the blocked route'};
    if(distance){
      const meters=distance.meters;
      if(this.bestDistance===null||meters<this.bestDistance-3||Math.abs(meters-(this.lastDistance??meters))>45){this.bestDistance=meters;this.progressAt=now;this.detours=0;}
      this.lastDistance=meters;
      if(this.progressAt!==null&&now-this.progressAt>12000){
        this.detours++;const routes=corridors(hints.depth,goal?.x??.5),left=routes.find(p=>p.x===.23),right=routes.find(p=>p.x===.77);
        this.detourSide=left&&right?(left.obstruction<right.obstruction?'a':'d'):(this.detours%2?'a':'d');this.detourUntil=now+12000;this.progressAt=now;
        return {action:control([this.detourSide,'space'],1200,{dx:this.detourSide==='a'?-50:50}),reason:'Objective distance stalled; taking a different passage'};
      }
    }
    if(!goal&&Math.abs(this.pitchDelta)>70){const dy=-clamp(this.pitchDelta,-100,100);this.pitchDelta+=dy;return {action:control([],350,{dy}),reason:'Restoring the exploration camera toward its starting pitch'};}
    if(!goal&&this.exploreSteps>=3){this.exploreSteps=0;return {action:control([],350,{dx:-130}),reason:'No objective or enemy after advancing; searching the adjacent passage'};}
    const paths=corridors(hints.depth,goal?.x??.5);
    if(!paths.length)throw Error('No valid depth map for navigation');
    if(this.lastTurn&&now-this.lastTurnAt<6000)for(const p of paths)if(Math.sign(p.x-.5)===-this.lastTurn)p.score+=.45;
    paths.sort((a,b)=>a.score-b.score);
    const path=paths[0];
    const forward=paths.find(p=>p.x===.5);
    if(this.pendingTurn&&forward?.groundRisk===0&&forward.obstruction<.8){this.pendingTurn=false;this.exploreSteps++;return {action:control(['w'],hints.idleWarning?2200:1000),reason:'Advancing into the clear ground after the turn',path:forward};}
    this.pendingTurn=false;
    if(paths.every(p=>p.groundRisk>0)){this.groundSearch++;if(this.groundSearch%3===1&&this.pitchDelta<70){this.pitchDelta+=35;return {action:control([],150,{dy:35}),reason:'Looking for a visible ground route'};}}else this.groundSearch=0;
    if(path.obstruction>.85)return {action:control(['s',this.detourSide],800,{dx:this.detourSide==='a'?-80:80}),reason:'Close obstacle ahead; backing away',path};
    const dx=Math.round((path.x-.5)*400);
    const lastEnemy=this.lastTargetAt>0&&now-this.lastTargetAt<5000;
    if(!goal&&lastEnemy)return {action:control([],200,{dx:70}),reason:'Reacquiring the last visible enemy'};
    // A depth-selected passage supplies the next waypoint, rather than steering
    // through a nearby wall toward the marker behind it. Every move is observed
    // again before extending the route.
    if(Math.abs(path.x-.5)>.065){this.pendingTurn=true;this.lastTurn=Math.sign(dx);this.lastTurnAt=now;return {action:control([],180,{dx}),reason:'Turning toward a visible traversable passage',path};}
    this.exploreSteps++;
    return {action:control(['w'],path.obstruction>.55?650:hints.idleWarning?2500:1600,{dx:0}),reason:goal?'Advancing through the open passage toward the objective':'Exploring the visible traversable passage',path};
  }
}
module.exports={Navigator};
