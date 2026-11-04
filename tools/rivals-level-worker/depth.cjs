'use strict';
const {spawn}=require('node:child_process'),readline=require('node:readline');
class DepthReader{
  constructor(binary,model){
    this.pending=[];this.closed=false;this.process=spawn(binary,[model],{stdio:['pipe','pipe','pipe']});
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    this.startup=setTimeout(()=>{this.rejectReady(Error('Depth model warmup timed out'));this.process.kill();},120000);
    readline.createInterface({input:this.process.stdout}).on('line',line=>{
      try{const r=JSON.parse(line);if(r.ready){clearTimeout(this.startup);this.resolveReady();return;}
        const p=this.pending.shift();if(!p){clearTimeout(this.startup);this.rejectReady(Error(r.error??'Depth startup failed'));return;}
        clearTimeout(p.timeout);r.ok?p.resolve(r):p.reject(Error(r.error));
      }catch(e){this.rejectReady(e);}
    });
    this.process.stderr.on('data',()=>{});this.process.stdin.on('error',()=>{});
    const close=()=>{clearTimeout(this.startup);this.closed=true;this.rejectReady(Error('Depth reader stopped'));for(const p of this.pending.splice(0)){clearTimeout(p.timeout);p.reject(Error('Depth reader stopped'));}};
    this.process.on('error',close);this.process.on('exit',close);
  }
  async read(file){await this.ready;if(this.closed)throw Error('Depth reader unavailable');return new Promise((resolve,reject)=>{
    const p={resolve,reject,timeout:setTimeout(()=>{reject(Error('Depth inference timed out'));this.process.kill();},10000)};this.pending.push(p);this.process.stdin.write(JSON.stringify({file})+'\n');
  });}
  async close(){this.process.stdin.end();}
}
module.exports={DepthReader};
