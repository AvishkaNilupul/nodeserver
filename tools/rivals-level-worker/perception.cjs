'use strict';
const {components}=require('./vision.cjs');

function coralCandidates(rgba,width,height,minRed){
  // Preserve thin coral outlines before joining adjacent outline pixels. A
  // 384px thumbnail erased them in the first live trial.
  const mask=Buffer.alloc(rgba.length);
  for(let y=Math.floor(height*.18);y<height*.75;y++)for(let x=Math.floor(width*.08);x<width*.93;x++){
    const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
    if(r<=minRed||g<=85||g>=155||b<=80||b>=155||r-g<80||r-b<85||g/b<.8||g/b>1.2)continue;
    for(let yy=y-2;yy<=y+2;yy++)for(let xx=x-2;xx<=x+2;xx++)mask[(yy*width+xx)*4]=255;
  }
  return components(mask,width,height,(d,i)=>d[i]>0,{left:.08,right:.93,top:.18,bottom:.75})
    .filter(b=>{const aspect=b.height*height/(b.width*width),density=b.pixels/(b.width*width*b.height*height);
      return b.width>.008&&b.width<.14&&b.height>.03&&b.height<.32&&aspect>1.15&&aspect<6&&density>.06&&density<.6;})
    .map(b=>({...b,y:b.y-b.height*.15,source:'coral-outline',confidence:.7}));
}
function outlinedEnemies(rgba,width,height,lines=[],{requireOpponentLabel=false}={}){
  const strong=coralCandidates(rgba,width,height,205);
  // Dim outlines alone overlap warm plants. Accept those only beneath an
  // independently observed red world-name label in the same fresh frame.
  const labels=lines.filter(l=>{
    if(l.confidence<.6||l.y<.18||l.y>.7||l.width>.2||l.height>.05)return false;
    let red=0;
    for(let y=Math.max(0,Math.floor(l.y*height));y<Math.min(height,Math.ceil((l.y+l.height)*height));y++)for(let x=Math.max(0,Math.floor(l.x*width));x<Math.min(width,Math.ceil((l.x+l.width)*width));x++){
      const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];if(r>150&&r>g*1.4&&r>b*1.3)red++;
    }
    return red>10;
  });
  if(!labels.length)return requireOpponentLabel?[]:strong;
  for(const t of coralCandidates(rgba,width,height,175)){
    if(!labels.some(l=>t.x>=l.x-.02&&t.x<=l.x+l.width+.02&&t.y>l.y&&t.y<l.y+.22))continue;
    if(strong.some(b=>Math.hypot(b.x-t.x,b.y-t.y)<.05))continue;
    strong.push({...t,source:'named-coral-outline',confidence:.85});
  }
  for(const label of labels){
    // AI opponents keep a red Easy label even when a large hero's glow breaks
    // the thin-outline shape. Aim below that fresh world label, never kill feed.
    if(!/[- ]EAS[YV]?$/i.test(label.text.trim()))continue;
    const x=label.x+label.width/2,y=label.y+Math.max(.045,Math.min(.09,label.height*5));
    if(strong.some(t=>t.source==='named-coral-outline'&&Math.hypot(t.x-x,t.y-y)<.08))continue;
    strong.push({x,y,width:.035,height:.1,source:'enemy-nameplate',confidence:.8});
  }
  if(!requireOpponentLabel)return strong;
  const opponents=labels.filter(l=>/[- ]EAS[YV]?$/i.test(l.text.trim()));
  return strong.filter(t=>t.source==='enemy-nameplate'||opponents.some(l=>t.x>l.x-.06&&t.x<l.x+l.width+.06&&t.y>l.y&&t.y<l.y+.3));
}
function excludeFriendlyNameplates(targets,rgba,width,height,lines=[]){
  const friendly=[];
  for(const line of lines){
    if(line.y<.08||line.y>.75||line.x<.08||line.x>.93||line.confidence<.6)continue;
    let blue=0,red=0;
    for(let y=Math.max(0,Math.floor(line.y*height));y<Math.min(height,Math.ceil((line.y+line.height)*height));y++)for(let x=Math.max(0,Math.floor(line.x*width));x<Math.min(width,Math.ceil((line.x+line.width)*width));x++){
      const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(r<120&&g>65&&b>150&&b>g*1.2&&b>r*1.4)blue++;
      if(r>190&&r>g*1.4&&r>b*1.3)red++;
    }
    if(blue>10&&blue>red*2)friendly.push(line);
  }
  return targets.filter(t=>!friendly.some(l=>t.x>=l.x-.015&&t.x<=l.x+l.width+.015&&t.y>=l.y&&t.y<l.y+.16));
}
function objectiveArrows(rgba,width,height){
  const color=(d,i)=>(d[i]>200&&d[i+1]>80&&d[i+1]<190&&d[i+2]<140&&d[i]-d[i+1]>40)||(d[i]<150&&d[i+1]>75&&d[i+2]>160&&d[i+2]>d[i]*1.3&&d[i+2]>d[i+1]*1.1);
  const neutral=(d,i)=>Math.min(d[i],d[i+1],d[i+2])>145&&Math.max(d[i],d[i+1],d[i+2])-Math.min(d[i],d[i+1],d[i+2])<40;
  const region={left:.08,right:.93,top:.25,bottom:.75};
  const boxes=[...components(rgba,width,height,color,region),...components(rgba,width,height,neutral,region).map(b=>({...b,neutral:true}))];
  const white=(left,right,top,bottom)=>{let count=0;for(let y=Math.max(0,Math.floor(top*height));y<Math.min(height,Math.ceil(bottom*height));y++)for(let x=Math.max(0,Math.floor(left*width));x<Math.min(width,Math.ceil(right*width));x++){const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];if(Math.min(r,g,b)>145&&Math.max(r,g,b)-Math.min(r,g,b)<40)count++;}return count;};
  return boxes.filter(b=>{const aspect=b.width*width/(b.height*height),density=b.pixels/(b.width*width*b.height*height);return (b.x<.25||b.x>.75||b.y>.65)&&b.width>.01&&b.width<.055&&b.height>.015&&b.height<.09&&aspect>.7&&aspect<1.6&&(b.neutral||density>.4)&&white(b.x-b.width*.25,b.x+b.width*.25,b.y-b.height*.25,b.y+b.height*.25)>10;}).filter(b=>{
    if(!b.neutral)return true;
    // The locked objective's white glyph sits on a dark gray circular plaque.
    // Plain white scenery/text with a nearby bright patch is not a waypoint.
    let plaque=0;
    for(let n=0;n<16;n++){
      const a=n*Math.PI/8,x=Math.round((b.x+Math.cos(a)*b.width*.9)*width),y=Math.round((b.y+b.height*.3+Math.sin(a)*b.height*.9)*height),i=(y*width+x)*4;
      const c=[rgba[i],rgba[i+1],rgba[i+2]];if(Math.max(...c)<130&&Math.max(...c)-Math.min(...c)<25)plaque++;
    }
    return plaque>=13;
  }).flatMap(b=>{
    const left=b.x-b.width/2,right=b.x+b.width/2,top=b.y-b.height*.38,bottom=b.y+b.height*(b.neutral?1.5:.38);
    if(b.y>.65&&white(left-.012,right+.012,b.y+b.height*.8,b.y+b.height*2.4)>8)return [{...b,bearing:b.x<.5?'left':'right',behind:true,source:'objective-arrow'}];
    const l=white(left-.018,left-.002,top,bottom),r=white(right+.002,right+.018,top,bottom);
    if(Math.max(l,r)<8)return [];return [{...b,bearing:b.x<.5?'left':'right',source:'objective-arrow'}];
  });
}
const quantile=(a,q)=>{const s=[...a].filter(Number.isFinite).sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(s.length*q))]??0;};
function corridors(depth,goalX=.5){
  if(!depth||depth.inverseDepth?.length!==depth.width*depth.height)return [];
  const {width:w,height:h,inverseDepth:d}=depth,values=[];
  for(let y=Math.floor(h*.3);y<h*.7;y++)for(let x=Math.floor(w*.15);x<w*.85;x++)values.push(d[y*w+x]);
  const low=quantile(values,.1),high=quantile(values,.9),span=high-low;
  if(!(span>1e-6))return [];
  const candidates=[];
  for(const x of [.23,.32,.41,.5,.59,.68,.77]){
    const patch=[];
    // Examine the passage ahead, above the player's lower body and floor.
    // The third-person body is left of the crosshair. A narrow ray can see
    // past a doorway while the body keeps colliding with its left jamb.
    for(let yy=Math.floor(h*.38);yy<h*.59;yy++)for(let xx=Math.floor(w*(x-.10));xx<w*(x+.065);xx++)patch.push(d[yy*w+xx]);
    const upper=Math.max(0,Math.min(1,(quantile(patch,.85)-low)/span));
    const ground=[];
    for(const y of [.55,.61,.67,.73,.79]){
      const band=[];for(let yy=Math.floor(h*(y-.012));yy<=Math.floor(h*(y+.012));yy++)for(let xx=Math.floor(w*(x-.018));xx<=Math.floor(w*(x+.018));xx++)band.push(d[yy*w+xx]);
      ground.push(quantile(band,.5));
    }
    const rise=(ground.at(-1)-ground[0])/span,near=(quantile(ground,.5)-low)/span;
    const backward=Math.min(...ground.slice(1).map((v,i)=>(v-ground[i])/span));
    // Ground gets progressively nearer toward the bottom of the view. A flat
    // near strip is a wall/railing; a sudden reverse is a ledge or occluder.
    // Looking only above the crosshair falsely treated space beyond rails as a route.
    const jump=Math.max(...ground.slice(1).map((v,i)=>(v-ground[i])/span));
    const groundRisk=backward<-.12||rise>.08&&jump/rise>.65&&near>.18?1:rise<.08?(near>.2?1:.6):0;
    const obstruction=Math.max(upper,groundRisk);
    candidates.push({x,obstruction,groundRise:rise,groundRisk,ground,score:upper*.65+groundRisk*1.8+Math.abs(x-goalX)*.9+Math.abs(x-.5)*.15});
  }
  return candidates.sort((a,b)=>a.score-b.score);
}
module.exports={outlinedEnemies,excludeFriendlyNameplates,objectiveArrows,corridors,quantile};
