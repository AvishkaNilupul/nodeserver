'use strict';

const normalize = text => String(text).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const lineText = frame => frame.lines.map(line => normalize(line.text)).join('\n');
function find(frame, expression, region = {}) {
  return frame.lines.filter(line => line.confidence >= 0.45 && expression.test(normalize(line.text)) &&
    line.x >= (region.left ?? 0) && line.y >= (region.top ?? 0) &&
    line.x + line.width <= (region.right ?? 1) && line.y + line.height <= (region.bottom ?? 1))
    .sort((a, b) => b.confidence - a.confidence)[0];
}
const center = line => ({x: line.x + line.width / 2, y: line.y + line.height / 2});
function worldDistance(frame){
  for(const line of frame.lines){
    if(line.confidence<.5||line.x<.1||line.x>.9||line.y<.25||line.y>.75||line.text.length>12)continue;
    const text=line.text.replace(/[Зз]/g,'3').replace(/[Мм]/g,'M').replace(/B(?=M)/g,'8');
    const match=text.match(/(?:^|[^\d])([\d]{1,3})\s*M(?:\b|[+^])/);
    if(match)return {...line,meters:Number(match[1])};
  }
  return null;
}
const worldObjective=frame=>find({...frame,lines:frame.lines.map(l=>({...l,text:l.text.replace(/[АВСЕНКМОРТХ]/g,c=>({'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M','О':'O','Р':'P','Т':'T','Х':'X'})[c])}))},/^(DEFEND|DEFENO|ATTACK|ATTAC|ESCORT|CAPTURE)$/,{left:.1,right:.9,top:.2,bottom:.75});
function uid(frame) {
  // The small animated telemetry footer frequently misreads 3/8 and 1/7.
  // Only the explicit profile/header UID is identity evidence. Once play starts,
  // the already verified session and exclusive lease retain that identity.
  const text = frame.lines.filter(line=>line.y<.5&&line.confidence>=.8).map(line => line.text).join(' ');
  return text.match(/\bUID\s*[:：]?\s*(\d{6,12})\b/i)?.[1] ?? null;
}
function matchLevelPanel(frame){
  const header=frame.lines.some(l=>l.x<.35&&l.y<.15&&/^(VICTORY|VICTURY|DEFEAT|DRAW)$/.test(normalize(l.text)));
  const label=find(frame,/^LEVEL$/,{left:.06,right:.2,top:.35,bottom:.55});
  if(!header||!label||!find(frame,/^ACCESSORY POINTS$/,{left:.06,right:.3,top:.4,bottom:.7}))return null;
  const row=label.y+.035;
  const level=frame.lines.find(l=>l.x>.07&&l.x<.12&&Math.abs(l.y-row)<.035&&/^\d{1,3}$/.test(l.text));
  const bar=frame.lines.find(l=>l.x>.115&&l.x<.25&&Math.abs(l.y-row)<.035&&/^[\d,]+\s*\/\s*[\d,]+$/.test(l.text));
  const gain=frame.lines.find(l=>l.x>.45&&l.x<.57&&Math.abs(l.y-row)<.035&&/^\+[\d,]+$/.test(l.text));
  if(!bar||!gain)return null;
  const counts=bar.text.split('/').map(s=>Number(s.trim().replaceAll(',','')));
  const isolated=frame.matchLevelBadge?.confidence>=60?frame.matchLevelBadge.level:null;
  return {level:level?Number(level.text):isolated,currentXp:counts[0],nextLevelXp:counts[1],earnedXp:Number(gain.text.slice(1).replaceAll(',','')),completedMatch:true};
}
function progress(frame) {
  const panel=matchLevelPanel(frame);if(panel)return panel;
  const text = frame.lines.map(line => line.text).join('\n');
  // Require labels. Bare scoreboard digits are never account XP or levels.
  const career = /CAREER/.test(text) && /OVERVIEW/.test(text) && /BASIC STATS|TIME PLAYED|MATCHES PLAYED|ACCOUNT LEVEL/.test(text);
  const level = text.match(/(?:ACCOUNT\s+LEVEL|PLAYER\s+LEVEL)[\s:]+(\d{1,3})\b/i) ??
    (career ? text.match(/(?:LEVEL|LV\.?)[\s:]+(\d{1,3})\b/i) : null);
  // Career's level badge is below the avatar, x .062-.083 / y .23-.27.
  // Never use unrelated bare digits.
  const badge = career && frame.lines.find(l=>l.x>=.055&&l.x<.09&&l.y>.225&&l.y<.28&&/^\d{1,3}$/.test(l.text));
  const isolated=career&&frame.accountLevelBadge?.confidence>=60&&Number.isInteger(frame.accountLevelBadge.level)&&frame.accountLevelBadge.level>=1&&frame.accountLevelBadge.level<=100?frame.accountLevelBadge.level:null;
  const xpLine=frame.lines.find(l=>l.confidence>=.8&&l.x>.25&&l.x<.85&&l.y>.1&&l.y<.9&&/^ACCOUNT\s+(?:XP|EXP|EXPERIENCE)\b/i.test(l.text));
  const xp = xpLine?.text.match(/^ACCOUNT\s+(?:XP|EXP|EXPERIENCE)(?:\s+(?:GAINED|EARNED))?[\s:+]+([\d,]+)/i);
  const bar = text.match(/\b([\d,]+)\s*\/\s*([\d,]+)\s*(?:XP|EXP)\b/i);
  return {level: level ? Number(level[1]) : isolated??(badge ? Number(badge.text) : null), earnedXp: xp ? Number(xp[1].replaceAll(',', '')) : null,
    currentXp: bar ? Number(bar[1].replaceAll(',', '')) : null,
    nextLevelXp: bar ? Number(bar[2].replaceAll(',', '')) : null};
}
function combatStats(frame,name){
  if(!name||!find(frame,/^PLAYER NAME$/)||!find(frame,/^DAMAGE$/)||!find(frame,/^ACCURACY$/))return null;
  const row=frame.lines.find(l=>l.x>.25&&l.x<.39&&normalize(l.text)===normalize(name));if(!row)return null;
  const read=(left,right,percent=false)=>{
    const l=frame.lines.find(l=>l.confidence>=.7&&l.x>=left&&l.x+l.width<=right&&Math.abs(l.y-row.y)<.015&&(percent?/^\d{1,3}%$/:/^[\d,.]+$/).test(l.text));
    return l?Number(l.text.replace(/[,.%]/g,'')):null;
  };
  const observed=frame.scoreboardNumbers?.name===name?frame.scoreboardNumbers:{};
  const value=(key,found)=>found??(observed[key]?.confidence>=60&&Number.isInteger(observed[key].value)&&observed[key].value>=0?observed[key].value:null);
  return {damage:value('damage',read(.645,.712)),finalHits:value('finalHits',read(.59,.645)),accuracy:value('accuracy',read(.855,.915,true)),proof:frame.output};
}
function classify(frame) {
  const text = lineText(frame);
  const alerts=frame.lines.filter(l=>!(l.x<.45&&l.y>.7)&&! /\[(?:SYSTEM|TEAM|MATCH|ALL)\]/i.test(l.text)).map(l=>normalize(l.text)).join('\n');
  if (/TERMS OF|PRIVACY POLICY|LICENSE AGREEMENT|AUTHORIZE|CAPTCHA|PURCHASE|PAYMENT|STEAM GUARD|SIGN IN TO STEAM/.test(alerts)) return 'review';
  if (/DISCONNECTED|CONNECTION LOST|NETWORK ERROR|NETWORK FLUCTUATION ALERT|RECONNECT|ACCOUNT SUSPENDED|ACCOUNT RESTRICTED/.test(alerts)) return 'blocked';
  if (frame.lines.some(l=>l.x>.7&&l.y>.65&&l.y<.9&&/\b(?:TIME|IMF)\W*\d{2}\s*[: ]\s*\d{2}/.test(normalize(l.text)))) return 'queue';
  if(/AMMO OVE|TEAM UP ACTIVATED|TEAM UP ABILITY ACTIVATED/.test(text))return 'preparing';
  if (/SELECT MODE/.test(text)) return 'mode-menu';
  if (/CHANGE MODE/.test(text) && /START/.test(text)) return 'play-menu';
  if (/NEXT OBJECTIVE/.test(text)&&/CAPTURED|CAPTURE THE|OBJECTIVE/.test(text))return 'round-transition';
  if(matchLevelPanel(frame))return 'xp';
  if(/PLAYER NAME/.test(text)&&/DAMAGE/.test(text)&&/ACCURACY/.test(text))return 'scoreboard';
  if(/ONE MORE ROUND/.test(text)&&/SCOREBOARD/.test(text))return 'post-team';
  if (frame.lines.some(l=>/^(VICTORY|DEFEAT|DRAW)$/.test(normalize(l.text))) && /CONTINUE|NEXT|MATCH|HIGHLIGHT/.test(text)) return 'result';
  if (/ACCOUNT (XP|EXP|EXPERIENCE)/.test(text)) return 'xp';
  if(frame.lines.some(l=>l.x>.7&&l.y>.6&&/^MVP$/.test(normalize(l.text))))return 'postmatch';
  if (/HOLD TO SKIP/.test(text)||/\bSPACE\b/.test(text)&&/\bSKIP\b/.test(text)) return 'intro';
  if(frame.lines.some(l=>/^QUICK MATCH (CONVOY|DOMINATION|CONVERGENCE)$/.test(normalize(l.text))))return 'preparing';
  if (/CONFIRM/.test(text)&&/TEAM UP ABILITIES|STRIKE SQUAD/.test(text)&&/DIFFICULTY|GAME STARTED|SUGGESTED PICK/.test(text)) return 'hero-select';
  if(/ABOUT TO BE REMOVED|YOU VE BEEN IDLE/.test(text)&&frame.lines.some(l=>l.x<.3&&l.y>.85&&/\d+\s*\/\s*40/.test(l.text)))return 'combat';
  if (/HERO PROFILE/.test(text)&&/COSMETICS|COSTUMES|PROFICIENCY|LORE/.test(text)) return 'hero-profile';
  if (/CAREER/.test(text) && /OVERVIEW/.test(text) && /BASIC STATS|TIME PLAYED|MATCHES PLAYED|ACCOUNT LEVEL/.test(text)) return 'career';
  if (/SELECT YOUR HERO|HERO SELECTION|CONFIRM SELECTION|CONFIRM YOUR HERO|ASSEMBLE YOUR TEAM/.test(text)) return 'hero-select';
  const hud=frame.lines.some(l=>l.x>.4&&l.x<.65&&l.y>.8&&/^\d+\s*\/\s*\d+$/.test(l.text));
  const clock=frame.lines.some(l=>l.x>.35&&l.x<.65&&l.y<.16&&/^\d{1,2}:\d{2}$/.test(l.text.trim()));
  const ammoHud=frame.lines.some(l=>l.x<.3&&l.y>.85&&/\d+\s*\/\s*4/.test(l.text));
  if(ammoHud&&(clock||find(frame,/^LSHIFT$/,{left:.7,top:.85})))return 'combat';
  if (/PREPARE TO/.test(text)&&hud) return 'combat';
  if (/PREPARE TO|WAITING FOR PLAYERS|MISSION STARTS|BATTLE STARTS|IGNITING THE TIMESTREAM|LOADING/.test(text)) return 'preparing';
  if (/RESPAWN|SPECTATING|ELIMINATED BY/.test(text)) return 'respawn';
  if (/PRACTICE VS AI|PRACTICE VS A I/.test(text) && /START|PLAY|CONFIRM|EASY|NORMAL/.test(text)) return 'ai-menu';
  if (/QUICK MATCH|COMPETITIVE/.test(text) && /PRACTICE|ARCADE/.test(text)) return 'mode-menu';
  if (/MATCH FOUND|MATCHMAKING|CANCEL SEARCH|SEARCHING/.test(text)) return 'queue';
  if (/PLAY/.test(text) && /HEROES/.test(text) && /STORE/.test(text)) return 'lobby';
  if(frame.lines.some(l=>l.x>.4&&l.x<.65&&l.y>.8&&/^\d+\s*\/\s*\d+$/.test(l.text)))return 'combat';
  if(worldObjective(frame)&&worldDistance(frame))return 'combat';
  return /ABOUT TO BE REMOVED|YOU VE BEEN IDLE|INACTIVITY|\bAFK\b/.test(text)?'blocked':'unknown';
}

// Extract small visible color regions. These are screen-space hints, never
// game entities or memory-derived positions. Commission against real screenshots.
function components(rgba, width, height, predicate, region) {
  const visited = new Uint8Array(width * height), found = [];
  for (let y = Math.floor(height * region.top); y < height * region.bottom; y++) {
    for (let x = Math.floor(width * region.left); x < width * region.right; x++) {
      const index = y * width + x;
      if (visited[index]) continue;
      visited[index] = 1;
      if (!predicate(rgba, index * 4)) continue;
      const queue = [index]; let n = 0, minX = x, maxX = x, minY = y, maxY = y;
      for (let k = 0; k < queue.length; k++) {
        const p = queue[k], px = p % width, py = Math.floor(p / width); n++;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        for (const [nx, ny] of [[px-1,py],[px+1,py],[px,py-1],[px,py+1]]) {
          if (nx < width * region.left || nx >= width * region.right || ny < height * region.top || ny >= height * region.bottom) continue;
          const ni = ny * width + nx;
          if (visited[ni]) continue;
          visited[ni] = 1;
          if (predicate(rgba, ni*4)) queue.push(ni);
        }
      }
      if (n >= 5) found.push({x: (minX+maxX)/2/width, y: (minY+maxY)/2/height,
        width: (maxX-minX+1)/width, height: (maxY-minY+1)/height, pixels: n});
    }
  }
  return found;
}
function features(rgba, width, height) {
  const play = {left: .08, right: .93, top: .15, bottom: .73};
  const red = components(rgba, width, height, (d,i) => d[i]>175 && d[i+1]<115 && d[i+2]<145 && d[i]-d[i+1]>90, play);
  // Prefer a thin horizontal red health bar. Big scenery patches are rejected.
  const enemies = red.filter(b => b.width > .018 && b.width < .16 && b.height < .018 && b.width/b.height > 3)
    .map(b => ({...b, y: Math.min(.8,b.y+Math.max(.02,Math.min(.055,b.width*.55)))}));
  const objectives = components(rgba,width,height,(d,i)=>d[i]<125&&d[i+1]>70&&d[i+2]>145&&d[i+2]>d[i+1]*1.2&&d[i+2]>d[i]*1.45,play)
    .filter(b=>b.width>.006&&b.width<.09&&b.height>.006&&b.height<.12&&b.pixels>5);
  // Spawn barriers are green rectangles in the real Spider-Islands receipt.
  // This is only an exit hint when a sizeable green connected border surrounds
  // the forward view; small scenery patches are excluded.
  const exits=components(rgba,width,height,(d,i)=>d[i+1]>60&&d[i]<d[i+1]*1.3&&d[i+2]<d[i+1]*.75,play)
    .filter(b=>b.width>.06&&b.width<.45&&b.height>.12&&b.height<.75&&b.pixels>40)
    .filter(b=>{
      // A portal has green side rails; a tree concentrates green in its center.
      const green=[0,0,0],area=[0,0,0],left=b.x-b.width/2;
      for(let y=Math.max(0,Math.ceil((b.y-b.height/2)*height));y<Math.min(height,(b.y+b.height/2)*height);y++)for(let x=Math.max(0,Math.ceil(left*width));x<Math.min(width,(b.x+b.width/2)*width);x++){
        const relative=(x/width-left)/b.width,k=relative<.15?0:relative>.85?1:2,i=(y*width+x)*4;
        area[k]++;if(rgba[i+1]>60&&rgba[i]<rgba[i+1]*1.3&&rgba[i+2]<rgba[i+1]*.75)green[k]++;
      }
      const density=green.map((n,i)=>n/Math.max(1,area[i]));return Math.min(density[0],density[1])>Math.max(.08,density[2]*.7);
    });
  const scene=[];
  for(let gy=0;gy<8;gy++)for(let gx=0;gx<12;gx++){
    const x=Math.min(width-1,Math.floor(width*(.12+gx*.065))),y=Math.min(height-1,Math.floor(height*(.2+gy*.06))),i=(y*width+x)*4;
    if(x/width>.28&&x/width<.51&&y/height>.5){scene.push(0);continue;}
    let sum=0,count=0;for(let yy=Math.max(0,y-6);yy<=Math.min(height-1,y+6);yy++)for(let xx=Math.max(0,x-6);xx<=Math.min(width-1,x+6);xx++){const j=(yy*width+xx)*4;sum+=rgba[j]+rgba[j+1]+rgba[j+2];count+=3;}
    scene.push(Math.round(sum/count));
  }
  return {enemies, objectives,exits,scene};
}
module.exports = {normalize, find, center, uid, progress, classify, features, components, matchLevelPanel, combatStats,worldDistance,worldObjective};
