'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');

async function remoteCheck(request, {load = require} = {}) {
  if (!/^[\w-]{8,100}$/.test(request.id ?? '') || !/^[a-f\d]{24}$/i.test(request.steamId ?? '')) throw Error('Invalid preparation identity');
  load('dotenv').config({quiet: true});
  const mongoose = load('mongoose');
  await mongoose.connect(process.env.MONGO_URI, {serverSelectionTimeoutMS: 10000, autoIndex: false});
  try {
    const db = mongoose.connection.db, steamId = new mongoose.Types.ObjectId(request.steamId);
    const prep = await db.collection('rivalspreparations').findOne({_id: request.id}, {projection: {status:1, steamId:1, holdId:1, reservedCount:1, twitchId:1}});
    const account = await db.collection('steamaccounts').findOne({_id: steamId}, {projection: {stage:1, notes:1, soldAt:1, accountName:1}});
    if (!prep || String(prep.steamId) !== request.steamId || prep.status !== 'held' || prep.holdId !== request.holdId) throw Error('Preparation is no longer exclusively held');
    if (!account || account.stage !== 'problem' || account.soldAt || !String(account.notes).includes(request.id) || account.accountName !== request.steamLogin) throw Error('Steam account is no longer held for this job');
    const count = (collection, query) => db.collection(collection).countDocuments(query, {limit:1, maxTimeMS:5000});
    if (await count('steamlistings', {accounts: {$elemMatch: {steamAccountId:steamId, state:{$ne:'removed'}}}}) ||
        await count('steamsales', {'accounts.steamAccountId':steamId}) ||
        await count('steamg2gunits', {steamAccountId:steamId, state:{$ne:'removed'}}) ||
        await count('steamboosts', {steamAccountId:steamId, state:{$in:['queued','boosting','stopping']}})) throw Error('Account has a listing, sale or active booster');
    const held = await db.collection('droplogs').countDocuments({account:prep.twitchId, soldSetId:prep.holdId, soldToUsername:'manual', soldAt:{$ne:null}}, {maxTimeMS:5000});
    if (held < prep.reservedCount) throw Error('Consumed reward hold changed');
    return {id:request.id, steamId:request.steamId, held:true, checkedAt:new Date().toISOString()};
  } finally { await mongoose.disconnect(); }
}

function check(job, {spawnProcess=spawn, target, keyFile} = {}) {
  target ??= JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/SteamAccountGenerator/cloud.json'),'utf8'));
  keyFile ??= path.join(os.homedir(),'.ssh/claude_prod_deploy_ed25519');
  if (!/^[a-z0-9@.:-]+$/i.test(target.host ?? '') || !/^\/[A-Za-z0-9._\/-]+$/.test(target.remoteRoot ?? '')) throw Error('Invalid private server configuration');
  const request = {id:job.id,steamId:job.steamAccountId,holdId:job.holdId,steamLogin:job.steamLogin};
  const code = `(${remoteCheck.toString()})(${JSON.stringify(request)}).then(x=>console.log(JSON.stringify({ok:true,result:x}))).catch(()=>{console.log(JSON.stringify({ok:false,error:'Fresh exclusive preparation hold could not be verified'}));process.exitCode=1;});`;
  return new Promise((resolve,reject) => {
    const p = spawnProcess('ssh',['-i',keyFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',target.host,'cd '+target.remoteRoot+' && node -'],{stdio:['pipe','pipe','pipe'],timeout:30000});
    let output='';p.stdout.on('data',c=>{output+=c;if(output.length>4096)p.kill();});p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});
    p.on('error',()=>reject(Error('Read-only stock check unavailable')));
    p.on('close',code=>{try{const r=JSON.parse(output.trim());if(code!==0||!r.ok)throw Error();resolve(r.result);}catch{reject(Error('Fresh exclusive preparation hold could not be verified'));}});
    p.stdin.end(code);
  });
}
module.exports = {check,remoteCheck};
