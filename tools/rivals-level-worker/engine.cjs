'use strict';
const {find,center,uid,progress,classify} = require('./vision.cjs');
const OWNER = 'rivals-level-worker';
const click = line => ({command:'click',...center(line)});
const controls = (keys=[],milliseconds=100,extra={}) => ({command:'controls',keys,milliseconds,...extra});
class Engine {
  constructor({expectedUid,targetLevel=15,maxMatches=1,now=Date.now}) {
    if(!/^\d{6,12}$/.test(expectedUid ?? '')||!Number.isInteger(targetLevel)||targetLevel<2||targetLevel>100||!Number.isInteger(maxMatches)||maxMatches<1||maxMatches>50)throw Error('Invalid leveling limits');
    this.uid=expectedUid;this.targetLevel=targetLevel;this.maxMatches=maxMatches;this.now=now;
    this.startedAt=now();this.lastStateAt=now();this.lastState=null;this.unknownSince=null;this.lastHintAt=null;
    this.identityVerified=false;this.modeVerified=false;this.inMatch=false;this.resultAt=null;this.matches=[];
    this.baseline=null;this.lastAimAt=0;this.steps=0;this.complete=false;
    this.scene=null;this.staticSince=null;
  }
  state(){return {uid:this.uid,identityVerified:this.identityVerified,modeVerified:this.modeVerified,inMatch:this.inMatch,
    baseline:this.baseline,matches:this.matches,complete:this.complete,startedAt:new Date(this.startedAt).toISOString()};}
  step(frame,hints={enemies:[],objectives:[]}) {
    this.steps++;
    const seenUid=uid(frame);
    if(seenUid&&seenUid!==this.uid)throw Error('Visible Rivals UID changed');
    if(seenUid===this.uid)this.identityVerified=true;
    if(!this.identityVerified)throw Error('Expected game UID is not visible; open Career Overview first');
    const kind=classify(frame),now=this.now(),p=progress(frame);
    if(p.level!==null&&p.level>=this.targetLevel){this.complete=true;return {kind,done:true,reason:'Observed target account level reached'};}
    if(kind!==this.lastState){this.lastState=kind;this.lastStateAt=now;}
    if(['review','blocked'].includes(kind))throw Error('Game requires review: '+kind);
    if(kind==='unknown'){
      this.unknownSince??=now;
      if(now-this.unknownSince>12000)throw Error('Unrecognized game screen; no automatic click-through');
      return {kind,wait:true};
    }
    this.unknownSince=null;
    if(!this.baseline&&p.level!==null)this.baseline={...p,at:frame.capturedAt,proof:frame.output};
    if(kind==='career'){
      if(!this.baseline)throw Error('Account level needs calibration from the actual Career screen');
      return {kind,action:controls(['escape'])};
    }
    if(kind==='hero-profile')return {kind,action:controls(['escape'])};
    if(kind==='lobby'){
      if(this.inMatch&&!this.resultAt)throw Error('Returned to lobby without a completed-match result');
      if(this.resultAt)throw Error('Account XP was not verified before leaving the match result');
      const play=find(frame,/^PLAY$/,{top:0,bottom:.3});
      if(!play)throw Error('Visible Play button could not be located');
      return {kind,action:click(play)};
    }
    if(kind==='mode-menu'){
      const ai=find(frame,/^PRACTICE VS A ?I$/);
      if(!ai)throw Error('Practice vs AI is not visible; calibrate mode selection');
      return {kind,action:click(ai)};
    }
    if(kind==='ai-menu'){
      this.modeVerified=true;
      const start=find(frame,/^(START|PLAY|CONFIRM|START MATCH)$/,{top:.5});
      if(!start)throw Error('AI difficulty/start screen needs calibration');
      return {kind,queue:true,action:click(start)};
    }
    if(['queue','preparing','respawn'].includes(kind)){
      if(!this.modeVerified)throw Error('AI mode was not verified for this match');
      if(now-this.lastStateAt>180000)throw Error('Match transition exceeded three minutes');
      return {kind,wait:true};
    }
    if(kind==='hero-select'){
      if(!this.modeVerified)throw Error('AI mode was not verified before hero selection');
      const punisher=find(frame,/^(THE )?PUNISHER$/);
      if(!punisher)throw Error('Punisher selection requires calibration from this roster');
      const confirm=find(frame,/^(CONFIRM|CONFIRM SELECTION|READY)$/);
      this.inMatch=true;
      return {kind,action:click(confirm??punisher)};
    }
    if(kind==='combat'){
      if(!this.inMatch||!this.modeVerified)throw Error('Combat requires the verified AI queue and hero selection');
      if(Array.isArray(hints.scene)&&hints.scene.length){
        const previous=this.scene;this.scene=hints.scene;
        const difference=previous?.length===hints.scene.length?hints.scene.reduce((n,x,i)=>n+Math.abs(x-previous[i]),0)/hints.scene.length:Infinity;
        if(difference<2)this.staticSince??=now;else this.staticSince=null;
        if(this.staticSince!==null&&now-this.staticSince>8000)throw Error('Gameplay image stopped changing; navigation needs calibration');
      }
      const enemy=[...hints.enemies].sort((a,b)=>Math.hypot(a.x-.5,a.y-.48)-Math.hypot(b.x-.5,b.y-.48))[0];
      const objective=[...hints.objectives].sort((a,b)=>Math.abs(a.x-.5)-Math.abs(b.x-.5))[0];
      if(enemy){
        this.lastHintAt=now;
        return {kind,action:controls([],650,{dx:Math.round((enemy.x-.5)*300),dy:Math.round((enemy.y-.48)*220),fire:true})};
      }
      if(objective){
        this.lastHintAt=now;
        return {kind,action:controls(['w'],800,{dx:Math.round((objective.x-.5)*220)})};
      }
      this.lastHintAt??=now;
      if(now-this.lastHintAt>10000)throw Error('No visible navigation or combat target for ten seconds; stopped for calibration');
      // Bounded scan, with no firing and no unobserved forward movement.
      return {kind,action:controls([],100,{dx:55})};
    }
    if(kind==='result'){
      if(!this.inMatch)throw Error('Result has no matching active benchmark');
      this.resultAt??=now;
      const next=find(frame,/^(CONTINUE|NEXT)$/,{top:.5});
      return {kind,...(next?{action:click(next)}:{wait:true})};
    }
    if(kind==='xp'){
      if(!this.resultAt||!this.inMatch)throw Error('XP screen has no completed benchmark match');
      if(!(p.earnedXp>0))throw Error('Positive account XP could not be read; preserve result for review');
      this.matches.push({earnedXp:p.earnedXp,level:p.level,proof:frame.output,observedAt:frame.capturedAt,
        elapsedSeconds:Math.round((now-(this.matches.at(-1)?.endedAt??this.startedAt))/1000),endedAt:now});
      this.inMatch=false;this.resultAt=null;this.modeVerified=false;
      if(this.matches.length>=this.maxMatches){this.complete=true;return {kind,done:true,reason:'Commissioning match limit reached'};}
      const next=find(frame,/^(CONTINUE|NEXT|RETURN TO LOBBY)$/,{top:.5});
      if(!next)throw Error('Verified XP result has no visible continuation');
      return {kind,action:click(next)};
    }
    throw Error('Screen has no commissioned action');
  }
}
module.exports={Engine,OWNER,controls};
