'use strict';
const {spawn} = require('node:child_process');
const readline = require('node:readline');
class Driver {
  constructor(binary) {
    this.pending=[];this.process=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
    this.closed=false;
    readline.createInterface({input:this.process.stdout}).on('line',line=>{
      const next=this.pending.shift();if(!next)return;
      clearTimeout(next.timeout);
      try{const r=JSON.parse(line);if(!r.ok)next.reject(Error(r.error));else next.resolve(r.result);}catch(e){next.reject(e);}
    });
    this.process.stderr.on('data',()=>{});this.process.stdin.on('error',()=>{});
    const close=()=>{this.closed=true;for(const p of this.pending.splice(0)){clearTimeout(p.timeout);p.reject(Error('Native driver stopped'));}};
    this.process.on('error',close);this.process.on('exit',close);
  }
  request(payload) {
    if(this.closed)return Promise.reject(Error('Native driver unavailable'));
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,timeout:setTimeout(()=>{reject(Error('Native driver response timed out'));this.process.kill('SIGTERM');},payload.command==='analyze'?60000:15000)};
      this.pending.push(item);this.process.stdin.write(JSON.stringify(payload)+'\n');
    });
  }
  async close(){if(this.closed)return;try{await this.request({command:'release'});}finally{this.process.stdin.end();}}
}
module.exports={Driver};
