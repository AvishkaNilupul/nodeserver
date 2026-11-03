const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const {requireSuperadmin} = require('../middleware/auth');
const {decrypt} = require('../utils/secretBox');
const Account = require('../models/ValorantAccount');
const SalesState = require('../models/ValorantSalesState');

const SHARDS = ['NA','EU','AP','LATAM','BR','KR'];
function blockers(a) {
  const result = [];
  if (a.stage !== 'stock') result.push(a.stage === 'signup_pending' ? 'Signup unfinished' : 'Account is ' + a.stage);
  if (!a.country || !a.shard || !a.regionCheckedAt) result.push('Check Riot residence and game region');
  if (!a.loginVerifiedAt) result.push('Verify the Riot login');
  if (!a.emailVerified) result.push('Verify the linked email');
  return result;
}
function publicRow(a) {
  const {_id,localId,accountName,requestedCountry,proxyCountry,expectedShard,country,shard,regionCheckedAt,
    regionEvidence,riotId,puuid,emailVerified,loginVerifiedAt,level,rank,skinCount,agentCount,stage,
    signedUpAt,importedAt,notes,listingId,listingUrl,priceUsd,soldAt,updatedAt} = a;
  return {_id:String(_id),localId,accountName,requestedCountry,proxyCountry,expectedShard,country,shard,
    regionCheckedAt,regionEvidence,riotId,puuid,emailVerified,loginVerifiedAt,level,rank,skinCount,agentCount,
    stage,signedUpAt,importedAt,notes,listingId,listingUrl,priceUsd,soldAt,updatedAt,blockers:blockers(a)};
}
function buildUpdate(body,current) {
  const set = {};
  if ('notes' in body) {
    if (typeof body.notes !== 'string' || body.notes.length > 2000) throw Error('Notes must be at most 2000 characters');
    set.notes = body.notes;
  }
  for (const [key,max] of [['riotId',100],['puuid',100],['rank',40]]) if (key in body) {
    if (typeof body[key] !== 'string' || body[key].length > max) throw Error('Invalid ' + key);
    set[key] = body[key].trim();
  }
  for (const key of ['level','skinCount','agentCount']) if (key in body) {
    const value = body[key];
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > (key === 'level' ? 1000 : 100000))) throw Error('Invalid ' + key);
    set[key] = value;
  }
  if ('regionCheck' in body) {
    const r = body.regionCheck;
    if (!r || !/^[A-Z]{2}$/.test(r.country || '') || !SHARDS.includes(r.shard) || typeof r.evidence !== 'string' || !r.evidence.trim() || r.evidence.length > 500) throw Error('A region check needs the observed country, shard and evidence');
    if (current.stage === 'signup_pending') throw Error('Complete signup before verifying the account region');
    Object.assign(set,{country:r.country,shard:r.shard,regionEvidence:r.evidence.trim(),regionCheckedAt:new Date()});
  }
  if ('emailVerified' in body || 'loginVerified' in body) {
    if (current.stage === 'signup_pending') throw Error('Complete signup before verifying the login');
    if ('emailVerified' in body) {if (typeof body.emailVerified !== 'boolean') throw Error('Invalid email verification');set.emailVerified = body.emailVerified;}
    if ('loginVerified' in body) {if (typeof body.loginVerified !== 'boolean') throw Error('Invalid login verification');set.loginVerifiedAt = body.loginVerified ? new Date() : null;}
  }
  return set;
}
function createRouter({AccountModel=Account,StateModel=SalesState,eld=require('../utils/eldoradoAccountOffers')} = {}) {
  const router = express.Router();
  router.get('/valorant-accounts.html',requireSuperadmin,(_req,res) => res.sendFile(path.join(__dirname,'../public/valorant-accounts.html')));
  router.use('/api/valorant',requireSuperadmin,(_req,res,next) => {res.set('Cache-Control','no-store');next();});
  router.use('/api/valorant',(req,res,next)=>{
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      try {if (req.get('origin') && new URL(req.get('origin')).host !== req.get('host')) return res.sendStatus(403);} catch {return res.sendStatus(403);}
      if(req.get('sec-fetch-site')==='cross-site')return res.sendStatus(403);
    } next();
  });
  router.get('/api/valorant/accounts',async (_req,res) => {
    try {
      const [docs,permission] = await Promise.all([AccountModel.find({}).sort({createdAt:-1}).limit(1000).lean(),StateModel.findById('eldorado').lean()]);
      const accounts = docs.map(publicRow),summary = {total:accounts.length,completed:0,pending:0,ready:0,listed:0,sold:0,regions:0};
      for (const a of accounts) {if (a.stage === 'signup_pending') summary.pending++;else summary.completed++;if (!a.blockers.length) summary.ready++;if (a.stage === 'listed') summary.listed++;if (a.stage === 'sold') summary.sold++;}
      summary.regions = new Set(accounts.filter(a=>a.stage!=='signup_pending').map(a=>a.shard).filter(Boolean)).size;
      res.json({success:true,accounts,summary,permission:permission || {canSell:null,checkedAt:null}});
    } catch {res.status(500).json({success:false,message:'Could not load Valorant accounts'});}
  });
  router.get('/api/valorant/accounts/:id/credentials',async (req,res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
    try {const a = await AccountModel.findById(req.params.id).select('+password +email +birthDate').lean();
      if (!a) return res.sendStatus(404);
      const password = decrypt(a.password), email = decrypt(a.email), birthDate = decrypt(a.birthDate);
      if (!password || !email) throw Error();
      res.json({success:true,accountName:a.accountName,password,email,birthDate});
    } catch {res.status(500).json({success:false,message:'Could not read saved credentials'});}
  });
  router.patch('/api/valorant/accounts/:id',async (req,res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
    try {
      const current = await AccountModel.findById(req.params.id).lean(); if (!current) return res.sendStatus(404);
      if (['listing','listed','sold'].includes(current.stage)) return res.status(409).json({success:false,message:'Remove the account from sale before changing its details'});
      let set;try {set=buildUpdate(req.body||{},current);}catch(e){return res.status(400).json({success:false,message:e.message});}
      if (!Object.keys(set).length) return res.status(400).json({success:false,message:'Nothing to save'});
      const saved = await AccountModel.findOneAndUpdate({_id:current._id,stage:current.stage,updatedAt:current.updatedAt},{$set:set},{returnDocument:'after',runValidators:true}).lean();
      if (!saved) return res.status(409).json({success:false,message:'Account changed; reload and try again'});
      res.json({success:true,account:publicRow(saved)});
    } catch {res.status(500).json({success:false,message:'Could not save account details'});}
  });
  let checking = false;
  router.post('/api/valorant/eldorado/check',async (_req,res) => {
    if (checking) return res.status(409).json({success:false,message:'An Eldorado access check is already running'});
    checking=true;
    try {
      // Main application process owns the live cookie jar. No side-process
      // seller probe, session refresh, listing publish or category substitution.
      const p = await eld.epicPermission('32');
      const permission = {canSell:p.canSell,restricted:p.epicIsHighRisk,allowHighRiskOffers:p.allowHighRiskOffers,
        checkedAt:new Date(),error:p.error ? 'Eldorado access could not be fully checked. Try again later.' : ''};
      await StateModel.updateOne({_id:'eldorado'},{$set:permission},{upsert:true});
      res.json({success:true,permission});
    } catch {res.status(502).json({success:false,message:'Eldorado access check failed'});} finally {checking=false;}
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter=createRouter;
module.exports._internal={publicRow,buildUpdate,blockers};
