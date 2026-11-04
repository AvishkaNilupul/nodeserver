'use strict';
const fs=require('node:fs'),path=require('node:path');
async function render(file,output){
  const receipt=JSON.parse(fs.readFileSync(file,'utf8')),frame=receipt.frame??receipt,hints=receipt.hints??{},decision=receipt.decision??{},sharp=require('sharp');
  const source=frame.output??file.replace(/\.json$/,'');if(!fs.existsSync(source))throw Error('Original retained PNG is missing');
  const w=1280,meta=await sharp(source).metadata(),h=Math.round(w*meta.height/meta.width),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const elements=[];
  for(const b of hints.enemies??[]){const bw=(b.width??.035)*w,bh=(b.height??.06)*h;elements.push(`<rect x="${b.x*w-bw/2}" y="${b.y*h-bh*.35}" width="${bw}" height="${bh}" fill="none" stroke="#ff5454" stroke-width="3"/>`);}
  if(decision.path){const x=decision.path.x*w;elements.push(`<path d="M ${w*.5} ${h*.78} L ${x} ${h*.5}" stroke="#59ffa8" stroke-width="5"/><circle cx="${x}" cy="${h*.5}" r="12" fill="none" stroke="#59ffa8" stroke-width="4"/>`);}
  const label=esc([decision.kind,decision.reason,JSON.stringify(decision.action??{})].filter(Boolean).join(' | '));
  elements.push(`<rect y="${h-55}" width="${w}" height="55" fill="#111" fill-opacity=".9"/><text x="16" y="${h-22}" fill="white" font-family="monospace" font-size="15">${label}</text>`);
  const svg=Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${elements.join('')}</svg>`);
  await sharp(source).resize({width:w}).composite([{input:svg}]).png().toFile(output);fs.chmodSync(output,0o600);
  return path.resolve(output);
}
if(require.main===module)render(process.argv[2],process.argv[3]).then(f=>console.log(JSON.stringify({ok:true,file:f}))).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={render};
