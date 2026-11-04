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
function uid(frame) {
  const text = frame.lines.map(line => line.text).join(' ');
  return text.match(/\bUID\s*[:：]?\s*(\d{6,12})\b/i)?.[1] ?? null;
}
function progress(frame) {
  const text = frame.lines.map(line => line.text).join('\n');
  // Require labels. Bare scoreboard digits are never account XP or levels.
  const career = /CAREER/.test(text) && /OVERVIEW/.test(text);
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
function classify(frame) {
  const text = lineText(frame);
  if (/TERMS OF|PRIVACY POLICY|LICENSE AGREEMENT|AUTHORIZE|CAPTCHA|PURCHASE|PAYMENT|STEAM GUARD|SIGN IN TO STEAM/.test(text)) return 'review';
  if (/DISCONNECTED|CONNECTION LOST|NETWORK ERROR|RECONNECT|SUSPENDED|RESTRICTED|INACTIVITY|AFK/.test(text)) return 'blocked';
  if (/VICTORY|DEFEAT|DRAW/.test(text) && /CONTINUE|NEXT|MATCH|HIGHLIGHT/.test(text)) return 'result';
  if (/ACCOUNT (XP|EXP|EXPERIENCE)/.test(text)) return 'xp';
  if (/HERO PROFILE/.test(text)) return 'hero-profile';
  if (/CAREER/.test(text) && /OVERVIEW/.test(text)) return 'career';
  if (/SELECT YOUR HERO|HERO SELECTION|CONFIRM SELECTION|ASSEMBLE YOUR TEAM/.test(text)) return 'hero-select';
  if (/PREPARE TO|WAITING FOR PLAYERS|MISSION STARTS|BATTLE STARTS/.test(text)) return 'preparing';
  if (/RESPAWN|SPECTATING|ELIMINATED BY/.test(text)) return 'respawn';
  if (/PRACTICE VS AI|PRACTICE VS A I/.test(text) && /START|PLAY|CONFIRM|EASY|NORMAL/.test(text)) return 'ai-menu';
  if (/QUICK MATCH|COMPETITIVE/.test(text) && /PRACTICE|ARCADE/.test(text)) return 'mode-menu';
  if (/MATCH FOUND|MATCHMAKING|CANCEL SEARCH|SEARCHING/.test(text)) return 'queue';
  if (/PLAY/.test(text) && /HEROES/.test(text) && /STORE/.test(text)) return 'lobby';
  if (/ATTACK|DEFEND|ESCORT|CAPTURE|CONTESTED|OVERTIME|OBJECTIVE/.test(text) && /\d/.test(text)) return 'combat';
  return 'unknown';
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
    .map(b => ({...b, y: Math.min(.8,b.y+.055)}));
  const objectives = components(rgba,width,height,(d,i)=>d[i]<120&&d[i+1]>170&&d[i+2]>195,play)
    .filter(b=>b.width>.009&&b.width<.07&&b.height>.014&&b.height<.09&&b.pixels>12);
  const scene=[];
  for(let gy=0;gy<8;gy++)for(let gx=0;gx<12;gx++){
    const x=Math.min(width-1,Math.floor(width*(.12+gx*.065))),y=Math.min(height-1,Math.floor(height*(.2+gy*.06))),i=(y*width+x)*4;
    scene.push(Math.round((rgba[i]+rgba[i+1]+rgba[i+2])/3));
  }
  return {enemies, objectives,scene};
}
module.exports = {normalize, find, center, uid, progress, classify, features};
