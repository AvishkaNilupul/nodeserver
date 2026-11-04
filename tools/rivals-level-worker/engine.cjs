'use strict';
const {find,center,uid,progress,classify,combatStats} = require('./vision.cjs');
const {Navigator}=require('./navigator.cjs');
const OWNER = 'rivals-level-worker';
const click = line => ({command:'click',...center(line)});
const controls = (keys=[],milliseconds=100,extra={}) => ({command:'controls',keys,milliseconds,...extra});
class Engine {
  constructor({expectedUid,expectedName,targetLevel=15,maxMatches=1,now=Date.now}) {
    if(!/^\d{6,12}$/.test(expectedUid ?? '')||!Number.isInteger(targetLevel)||targetLevel<2||targetLevel>100||!Number.isInteger(maxMatches)||maxMatches<1||maxMatches>50)throw Error('Invalid leveling limits');
    this.uid=expectedUid;this.expectedName=expectedName;this.pendingStats=false;this.teamNames=new Set();this.targetLevel=targetLevel;this.maxMatches=maxMatches;this.now=now;
    this.startedAt=now();this.lastStateAt=now();this.lastState=null;this.unknownSince=null;this.lastHintAt=null;
    this.rosterActive=false;this.rosterReset=false;this.rosterPreviewAt=null;this.identityVerified=false;this.modeVerified=false;this.inMatch=false;this.resultAt=null;this.matches=[];
    this.baseline=null;this.lastAimAt=0;this.steps=0;this.complete=false;
    this.navigator=new Navigator();this.firstCombatAt=null;this.scene=null;this.staticSince=null;this.queueSubmittedAt=null;this.spawnExitSteps=0;
  }
  actionApplied(decision){if(decision.queue){this.queueSubmittedAt=this.now();this.firstCombatAt=null;this.rosterActive=false;}}
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
    if(kind!==this.lastState){this.lastState=kind;this.lastStateAt=now;if(kind==='combat'){this.lastHintAt=null;this.rosterActive=false;}if(kind==='hero-select'&&!this.rosterActive){this.rosterActive=true;this.rosterReset=false;this.rosterPreviewAt=null;}if(kind==='respawn'){this.spawnExitSteps=0;this.navigator.reset();}}
    if(['review','blocked'].includes(kind))throw Error('Game requires review: '+kind);
    if(this.inMatch&&!this.resultAt&&['play-menu','ai-menu','mode-menu','lobby'].includes(kind))throw Error('Returned to menus without a completed-match result');
    if(this.queueSubmittedAt!==null&&['play-menu','ai-menu','lobby','queue'].includes(kind)){
      if(now-this.queueSubmittedAt>180000)throw Error('Queue did not reach a match within three minutes');
      return {kind:'queue',wait:true};
    }
    if(kind==='unknown'){
      this.unknownSince??=now;
      if(now-this.unknownSince>(this.modeVerified&&this.firstCombatAt===null?90000:12000))throw Error('Unrecognized game screen; no automatic click-through');
      return {kind,wait:true};
    }
    this.unknownSince=null;
    if(kind==='round-transition'){
      if(!this.inMatch||!this.modeVerified)throw Error('Round transition requires the verified match');
      this.navigator.reset();this.firstCombatAt=null;this.rosterActive=false;
      if(now-this.lastStateAt>180000)throw Error('Round transition exceeded three minutes');
      return {kind,wait:true};
    }
    if(!this.baseline&&p.level!==null)this.baseline={...p,at:frame.capturedAt,proof:frame.output};
    if(kind==='career'){
      if(!this.baseline)throw Error('Account level needs calibration from the actual Career screen');
      const back=find(frame,/^BACK$/,{top:.8});
      return {kind,action:back?click(back):controls(['escape'])};
    }
    if(kind==='hero-profile'){const back=find(frame,/^BACK$/,{top:.8});return {kind,action:back?click(back):controls(['escape'])};}
    if(kind==='lobby'){
      if(this.inMatch&&!this.resultAt)throw Error('Returned to lobby without a completed-match result');
      if(this.resultAt)throw Error('Account XP was not verified before leaving the match result');
      const play=find(frame,/^PLAY$/,{top:0,bottom:.3});
      if(!play)throw Error('Visible Play button could not be located');
      return {kind,action:click(play)};
    }
    if(kind==='mode-menu'){
      const title=find(frame,/^PRACTICE$/,{left:.7,top:.5,bottom:.8});
      const vs=find(frame,/^VS A ?I$/,{left:.7,top:.5,bottom:.8});
      if(title&&vs){
        return {kind,action:click(vs)};
      }
      const ai=find(frame,/^PRACTICE VS A ?I$/,{left:.5,top:.4});
      if(!ai){const rivalry=find(frame,/^RIVALRY$/,{top:0,bottom:.15});if(rivalry)return {kind,action:click(rivalry)};throw Error('Practice vs AI card is not visible; calibrate mode selection');}
      return {kind,action:click(ai)};
    }
    if(kind==='play-menu'){
      const ai=find(frame,/^PRACTICE VS A ?I$/,{left:.7,top:.68,bottom:.86});
      if(ai){
        const start=find(frame,/^START$/,{left:.7,top:.75});
        if(!start)throw Error('AI mode has no visible Start control');
        this.modeVerified=true;
        return {kind,queue:true,action:click(start)};
      }
      const change=find(frame,/^CHANGE MODE/);
      if(!change)throw Error('Visible mode selector could not be located');
      return {kind,action:click(change)};
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
      for(const l of frame.lines)if(l.y>.88&&l.y<.93&&l.x>.2&&l.x<.8&&l.confidence>.7&&!/ABILIT|TEAM UP|ENTER|CHAT/i.test(l.text))this.teamNames.add(l.text);
      if(!this.modeVerified)throw Error('AI mode was not verified before hero selection');
      const punisher=find(frame,/^(THE )?PUNISHER$/,{right:.4});
      if(!punisher){
        const text=frame.lines.map(l=>l.text.toUpperCase()).join(' ');
        if(/DIFFICULTY|CONFIRM YOUR HERO|GAME STARTED|SUGGESTED PICK/.test(text)&&/TEAM.UP ABILITIES/.test(text)&&find(frame,/^C?ONFIRM$/,{left:.7})){
          // The radial roster retains its previous scroll position. Clamp it
          // to the first hero before previewing the calibrated portrait.
          if(!this.rosterReset){this.rosterReset=true;return {kind,action:{command:'scroll',x:.88,y:.35,amount:12,pulses:48}};}
          if(this.rosterPreviewAt===null){this.rosterPreviewAt=now;return {kind,action:{command:'click',x:.93,y:.505}};}
          if(now-this.rosterPreviewAt<8000)return {kind,wait:true};
          throw Error('Punisher portrait preview did not verify its left-side title');
        }
        if(now-this.lastStateAt<10000)return {kind,wait:true};
        throw Error('Punisher selection requires calibration from this roster');
      }
      const confirm=find(frame,/^(C?ONFIRM|CONFIRM SELECTION|READY)$/);
      if(!confirm)return {kind,wait:true};
      this.inMatch=true;
      return {kind,action:click(confirm)};
    }
    if(kind==='intro'){
      if(!this.modeVerified)throw Error('Intro has no verified AI queue');
      return {kind,action:controls(['space'],1200)};
    }
    if(kind==='combat'){
      this.queueSubmittedAt=null;
      this.firstCombatAt??=now;
      if(!this.inMatch||!this.modeVerified)throw Error('Combat requires the verified AI queue and hero selection');
      if(Array.isArray(hints.scene)&&hints.scene.length){
        const previous=this.scene;this.scene=hints.scene;
        const difference=previous?.length===hints.scene.length?hints.scene.reduce((n,x,i)=>n+Math.abs(x-previous[i]),0)/hints.scene.length:Infinity;
        if(difference<2)this.staticSince??=now;else this.staticSince=null;
        if(this.staticSince!==null&&now-this.staticSince>8000){if(hints.depth){hints.stalled=true;this.staticSince=null;}else throw Error('Gameplay image stopped changing; navigation needs calibration');}
      }
      if(hints.depth){hints.idleWarning=frame.lines.some(l=>/about to be removed|been idle/i.test(l.text));hints.teamNames=[...this.teamNames];const navigation=this.navigator.step(frame,hints,now);return {kind,...navigation};}
      const ammo=frame.lines.find(l=>l.x<.3&&l.y>.85&&/\b0\s*\/\s*40\b/.test(l.text));
      if(ammo)return {kind,action:controls(['r'],1200)};
      const exit=[...(hints.exits??[])].filter(b=>b.x>.3&&b.x<.7).sort((a,b)=>Math.abs(a.x-.5)-Math.abs(b.x-.5))[0];
      if(exit&&this.spawnExitSteps<3){
        this.spawnExitSteps++;this.lastHintAt=now;
        return {kind,action:controls(['w'],2500,{dx:Math.round((exit.x-.5)*220)})};
      }
      const enemy=[...hints.enemies].sort((a,b)=>Math.hypot(a.x-.5,a.y-.48)-Math.hypot(b.x-.5,b.y-.48))[0];
      const marker=find(frame,/^(DEFEND|ATTACK|ESCORT|CAPTURE)$/,{left:.08,right:.93,top:.2,bottom:.73});
      const distance=frame.lines.find(l=>l.confidence>=.5&&l.x>.1&&l.x<.9&&l.y>.25&&l.y<.75&&/^\d{1,3}M(?:\b|\s)/.test(l.text));
      const objective=(marker?center(marker):distance?{x:distance.x+distance.width/2,y:distance.y-.035}:null)??[...hints.objectives].sort((a,b)=>Math.abs(a.x-.5)-Math.abs(b.x-.5))[0];
      if(enemy){
        this.lastHintAt=now;
        return {kind,action:controls([this.steps%2?'a':'d'],900,{dx:Math.round((enemy.x-.5)*300),dy:Math.round((enemy.y-.5)*220),fire:true})};
      }
      if(objective){
        this.lastHintAt=now;
        return {kind,action:controls(['w'],2000,{dx:Math.round((objective.x-.5)*220)})};
      }
      this.lastHintAt??=now;
      if(now-this.lastHintAt>10000)throw Error('No visible navigation or combat target for ten seconds; stopped for calibration');
      // Bounded scan, with no firing and no unobserved forward movement.
      return {kind,action:controls([],100,{dx:55})};
    }
    if(kind==='scoreboard'){
      if(!this.pendingStats)throw Error('Scoreboard has no pending match receipt');
      const stats=combatStats(frame,this.expectedName);if(!stats)return {kind,wait:true};
      Object.assign(this.matches.at(-1),{combat:stats});this.pendingStats=false;
      if(this.matches.length>=this.maxMatches){this.complete=true;return {kind,done:true,reason:'Account XP and named scoreboard observed'};}
      const back=find(frame,/^BACK$/,{top:.8});return {kind,action:back?click(back):controls(['escape'])};
    }
    if(kind==='post-team'){
      if(this.inMatch&&!this.pendingStats)throw Error('Account XP was not verified; preserve the post-match team screen');
      const button=find(frame,this.pendingStats?/^SCOREBOARD$/:/^BACK$/,{top:.8});
      if(!button)throw Error('Post-match continuation is not visible');return {kind,action:click(button)};
    }
    if(kind==='postmatch'){if(!this.inMatch)throw Error('No active match for MVP');this.resultAt??=now;return {kind,wait:true};}
    if(kind==='result'){
      if(!this.inMatch)throw Error('Result has no matching active benchmark');
      this.resultAt??=now;
      const next=find(frame,/^(CONTINUE|NEXT)$/,{top:.5});
      return {kind,...(next?{action:click(next)}:{wait:true})};
    }
    if(kind==='xp'){
      if(this.pendingStats)return {kind,wait:true};
      if(!this.inMatch||(!this.resultAt&&!p.completedMatch))throw Error('XP screen has no completed benchmark match');
      if(!(p.earnedXp>0))throw Error('Positive account XP could not be read; preserve result for review');
      this.matches.push({earnedXp:p.earnedXp,level:p.level,proof:frame.output,observedAt:frame.capturedAt,
        elapsedSeconds:Math.round((now-(this.matches.at(-1)?.endedAt??this.startedAt))/1000),endedAt:now});
      this.inMatch=false;this.resultAt=null;this.modeVerified=false;this.queueSubmittedAt=null;
      if(this.expectedName){this.pendingStats=true;const next=find(frame,/^NEXT$/,{top:.5});return {kind,action:next?click(next):controls(['space'],120)};}
      if(this.matches.length>=this.maxMatches){this.complete=true;return {kind,done:true,reason:'Commissioning match limit reached'};}
      const next=find(frame,/^(CONTINUE|NEXT|RETURN TO LOBBY)$/,{top:.5});
      if(!next)throw Error('Verified XP result has no visible continuation');
      return {kind,action:click(next)};
    }
    throw Error('Screen has no commissioned action');
  }
}
module.exports={Engine,OWNER,controls};
