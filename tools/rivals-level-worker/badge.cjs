'use strict';
const sharp=require('sharp');
const {createWorker,PSM}=require('tesseract.js');

// Isolate the digit glyphs from the known Career badge. Border fragments touch
// the crop edges; the number is surrounded by the badge's dark interior.
function glyphMask(data,width,height){
  const seen=new Uint8Array(width*height),components=[];
  for(let p=0;p<data.length;p++){
    if(seen[p]||data[p]<100)continue;
    seen[p]=1;const queue=[p];let minX=width,minY=height,maxX=0,maxY=0,edge=false;
    for(let i=0;i<queue.length;i++){
      const n=queue[i],x=n%width,y=Math.floor(n/width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      if(x===0||y===0||x===width-1||y===height-1)edge=true;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=width||yy>=height)continue;
        const nn=yy*width+xx;if(seen[nn]||data[nn]<100)continue;seen[nn]=1;queue.push(nn);
      }
    }
    const b={minX,maxX,minY,maxY,edge,pixels:queue};
    if(edge&&queue.length>3&&(maxX-minX+1)<width*.4&&(maxY-minY+1)>height*.4)throw Error('A level digit or border is clipped; inspect the badge crop');
    if(!edge&&queue.length>=4&&(maxY-minY+1)>=height*.25)components.push(b);
  }
  if(components.length<1||components.length>3)throw Error('Level badge glyphs could not be separated');
  const mask=Buffer.alloc(width*height);
  for(const c of components)for(const p of c.pixels)mask[p]=255;
  const left=Math.min(...components.map(c=>c.minX)),top=Math.min(...components.map(c=>c.minY));
  return {mask,left,top,width:Math.max(...components.map(c=>c.maxX))-left+1,height:Math.max(...components.map(c=>c.maxY))-top+1,count:components.length};
}
class BadgeReader {
  constructor(cachePath){this.cachePath=cachePath;this.worker=null;}
  async warm(){
    this.worker??=await createWorker('eng',1,{cachePath:this.cachePath});
    await this.worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'0123456789',user_defined_dpi:'300'});
  }
  async read(file,region={left:.055,top:.235,width:.035,height:.028}){
    await this.warm();
    const metadata=await sharp(file).metadata();
    const crop={left:Math.round(metadata.width*region.left),top:Math.round(metadata.height*region.top),width:Math.round(metadata.width*region.width),height:Math.round(metadata.height*region.height)};
    const {data,info}=await sharp(file).extract(crop).greyscale().raw().toBuffer({resolveWithObject:true});
    const g=glyphMask(data,info.width,info.height);
    await this.worker.setParameters({tessedit_pageseg_mode:g.count===1?PSM.SINGLE_CHAR:PSM.SINGLE_WORD});
    const glyph=await sharp(g.mask,{raw:{width:info.width,height:info.height,channels:1}}).extract({left:g.left,top:g.top,width:g.width,height:g.height})
      .resize({height:160,kernel:'nearest'}).negate({alpha:false}).png().toBuffer();
    // Materialize inversion first: libvips otherwise also negates new padding.
    const candidates=[];
    for(const background of ['white','black']){
      const image=await sharp(glyph).extend({top:20,bottom:20,left:20,right:20,background}).png().toBuffer(),result=await this.worker.recognize(image),text=result.data.text.trim();
      if(/^[1-9]\d{0,2}$/.test(text)&&text.length===g.count&&Number(text)<=100&&result.data.confidence>=60)candidates.push({level:Number(text),confidence:result.data.confidence,background});
    }
    if(!candidates.length||new Set(candidates.map(c=>c.level)).size!==1)throw Error('Account level badge was not read confidently');
    candidates.sort((a,b)=>b.confidence-a.confidence);return {...candidates[0],crop,glyphCount:g.count};
  }
  async orangeNumber(file,region){
    await this.warm();const metadata=await sharp(file).metadata(),crop={left:Math.round(metadata.width*region.left),top:Math.round(metadata.height*region.top),width:Math.round(metadata.width*region.width),height:Math.round(metadata.height*region.height)};
    const {data,info}=await sharp(file).extract(crop).removeAlpha().raw().toBuffer({resolveWithObject:true}),mask=Buffer.alloc(info.width*info.height,255);let ink=0,left=info.width,top=info.height,right=0,bottom=0;
    for(let i=0;i<mask.length;i++){const j=i*info.channels,r=data[j],g=data[j+1],b=data[j+2];if(r>180&&g>65&&g<200&&b<120&&r>g*1.2){mask[i]=0;ink++;const x=i%info.width,y=Math.floor(i/info.width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}}
    if(ink<3)throw Error('Owned scoreboard number has no readable orange glyph');
    const glyph=await sharp(mask,{raw:{width:info.width,height:info.height,channels:1}}).extract({left,top,width:right-left+1,height:bottom-top+1}).resize({height:160,kernel:'nearest'}).png().toBuffer();
    const image=await sharp(glyph).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
    await this.worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_WORD,tessedit_char_whitelist:'0123456789'});const result=await this.worker.recognize(image),text=result.data.text.trim().replace(/\s/g,'');
    if(!/^\d{1,7}$/.test(text)||result.data.confidence<60)throw Error('Owned scoreboard number was not read confidently');
    return {value:Number(text),confidence:result.data.confidence,crop};
  }
  async close(){if(this.worker){await this.worker.terminate();this.worker=null;}}
}
module.exports={BadgeReader,glyphMask};
