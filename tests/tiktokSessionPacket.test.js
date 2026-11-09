const test = require('node:test'), assert = require('node:assert/strict');
const { parsePacket } = require('../utils/tiktokSessionPacket');
const packet = () => ({ account:'tiktok-05',seedRoom:'12',seedAnchor:'34',seed:{host:'webcast.tiktok.com',
  headers:[[':authority','webcast.tiktok.com'],[':method','POST'],[':path','/webcast/room/enter/'],['cookie','private'],['x-tt-token','private']],body:'YWJj'},
  wire:[{host:'webcast-frontier.tiktokv.eu',path:'/webcast/im/ws_proxy/?test=1',headers:[['cookie','private']],frames:['YWJj']}] });
test('session validation strips injected controller details and binds the account',()=>{
 const p=packet();p.server='https://wrong.test';p.workerKey='not allowed';
 const result=parsePacket(p,'tiktok-05');assert(result);assert(!result.text.includes('wrong.test'));
 assert.equal(parsePacket(p,'tiktok-06'),null);assert.equal(result.digest.length,64);
});
test('session validation rejects foreign hosts, headers, paths and oversized packets',()=>{
 for(const change of [p=>p.seed.host='localhost',p=>p.seed.headers.push(['bad','a\r\nb']),
 p=>p.seed.headers[2][1]='/webcast/room/enter.evil/',p=>p.wire[0].host='webcast-frontier.tiktokv.eu.evil.test',
 p=>p.wire[0].path='//evil.test',p=>p.wire[0].frames=['***'],p=>p.seed.body='A'.repeat(49000)]){
  const p=packet();change(p);assert.equal(parsePacket(p,'tiktok-05'),null);
 }
});

test('observed Singapore native socket origin is accepted',()=>{const p=packet();p.wire[0].host='webcast-frontier16-normal-alisg.tiktokv.com';assert(parsePacket(p,'tiktok-05'));});
