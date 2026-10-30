const express = require('express');
const EpicAccount = require('../models/EpicAccount');
const { requireSuperadmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/secretBox');
const router = express.Router();
const {fields:profileFields,cleanProfile,creationProfile,sampleContact}=require('../utils/epicAccountLocation');
const fields = { firstName:80,lastName:80,dateOfBirth:10,country:2,notes:4000,phone:80,address:500 };
const allowed = new Set([...Object.keys(fields), 'label', 'email', 'password', 'totpSecret']);
const projection = 'accountId displayName label email password totpSecret source accountDetails detailsUpdatedAt sold status libraryCount libraryValueUsd library createdAt';
function profile(account) {
  if (!account.accountDetails) return cleanProfile({});
  const plain = decrypt(account.accountDetails);
  if (!plain) throw Error('Stored details unavailable');
  const value = JSON.parse(plain);
  return cleanProfile(value);
}
function view(account) {
  return { _id: account._id, accountId: account.accountId, displayName: account.displayName,
    label: account.label, email: decrypt(account.email), source: account.source || 'manual',
    hasPassword: Boolean(account.password), hasTotpSecret: Boolean(account.totpSecret),
    details: profile(account), detailsUpdatedAt: account.detailsUpdatedAt,
    sold: Boolean(account.sold), status: account.status, libraryCount: account.libraryCount || 0,
    libraryValueUsd: account.libraryValueUsd || 0,
    games: (account.library || []).map(g => g.title).filter(Boolean), createdAt: account.createdAt };
}
router.post('/api/epic/accounts/details/backfill-location',requireSuperadmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {
    const accounts=await EpicAccount.find({}).select('_id accountDetails').lean();
    let changed=0,skipped=0;
    for(const a of accounts){
      const before=profile(a),after=creationProfile(before);
      if(req.body?.generateSamples===true)Object.assign(after,sampleContact(after));
      if(JSON.stringify(before)===JSON.stringify(after)){skipped++;continue;}
      const match={_id:a._id,accountDetails:a.accountDetails===undefined?{$exists:false}:a.accountDetails};
      const updated=await EpicAccount.findOneAndUpdate(match,{$set:{accountDetails:encrypt(JSON.stringify(after)),detailsUpdatedAt:new Date()}},{returnDocument:'after',runValidators:true}).select('_id').lean();
      if(updated)changed++;else skipped++;
    }
    res.json({success:true,changed,skipped});
  } catch {res.status(500).json({success:false,message:'Could not backfill account locations'});}
});
router.post('/api/epic/accounts/:id/details/sample-contact',requireSuperadmin,validId,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {
    const a=await EpicAccount.findById(req.params.id).select(projection).lean();
    if(!a)return res.status(404).json({success:false,message:'Account not found'});
    const before=profile(a);
    if(before.phone||before.address)return res.status(409).json({success:false,message:'Contact details already exist; edit them manually.'});
    if(!before.creationCountry&&!before.country)return res.status(400).json({success:false,message:'No recorded country is available for this account'});
    const match={_id:a._id,accountDetails:a.accountDetails===undefined?{$exists:false}:a.accountDetails};
    const updated=await EpicAccount.findOneAndUpdate(match,{$set:{accountDetails:encrypt(JSON.stringify(sampleContact(before))),detailsUpdatedAt:new Date()}},{returnDocument:'after',runValidators:true}).select(projection).lean();
    if(!updated)return res.status(409).json({success:false,message:'Details changed. Refresh before generating.'});
    res.json({success:true,account:view(updated)});
  }catch{res.status(500).json({success:false,message:'Could not generate sample contact'});}
});
router.use('/api/epic/accounts/:id/details', (req,res,next) => {
  res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next();
});
function validId(req,res,next) {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({success:false,message:'Invalid account ID'});
  next();
}
router.get('/api/epic/accounts/:id/details', requireSuperadmin, validId, async (req,res) => {
  try {
    const a = await EpicAccount.findById(req.params.id).select(projection).lean();
    if (!a) return res.status(404).json({success:false,message:'Account not found'});
    res.json({success:true,account:view(a)});
  } catch { res.status(500).json({success:false,message:'Could not read account details'}); }
});
router.patch('/api/epic/accounts/:id/details', requireSuperadmin, validId, async (req,res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>!allowed.has(k))) {
      return res.status(400).json({success:false,message:'Unsupported account detail field'});
    }
    const clean = {};
    for (const [key,value] of Object.entries(body)) {
      const max = fields[key] || ({label:160,email:254,password:256,totpSecret:256})[key];
      if (typeof value !== 'string' || value.length > max || value.includes('\0') || value.startsWith('enc:')) {
        return res.status(400).json({success:false,message:'Invalid '+key});
      }
      clean[key] = key === 'password' ? value : value.trim();
    }
    if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) return res.status(400).json({success:false,message:'Invalid email'});
    if (clean.country && !/^[A-Za-z]{2}$/.test(clean.country)) return res.status(400).json({success:false,message:'Country must be a two-letter code'});
    if (clean.dateOfBirth) {
      const d = new Date(clean.dateOfBirth+'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.dateOfBirth) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0,10)!==clean.dateOfBirth || d.getUTCFullYear()<1900 || d>Date.now()) {
        return res.status(400).json({success:false,message:'Invalid date of birth'});
      }
    }
    const a = await EpicAccount.findById(req.params.id).select(projection).lean();
    if (!a) return res.status(404).json({success:false,message:'Account not found'});
    const details = profile(a);
    const set = {detailsUpdatedAt:new Date()};
    for (const key of Object.keys(fields)) if (Object.hasOwn(clean,key)) details[key] = key==='country' ? clean[key].toUpperCase() : clean[key];
    if((Object.hasOwn(clean,'phone')&&clean.phone!==profile(a).phone)||(Object.hasOwn(clean,'address')&&clean.address!==profile(a).address))details.contactSource='manual';
    set.accountDetails = encrypt(JSON.stringify(details));
    if (Object.hasOwn(clean,'label')) set.label = clean.label;
    if (Object.hasOwn(clean,'email')) set.email = encrypt(clean.email.toLowerCase());
    // Blank credential inputs mean keep the stored value, including older accounts.
    for (const key of ['password','totpSecret']) if (clean[key]) set[key] = encrypt(clean[key]);
    const match = {_id:a._id, accountDetails: a.accountDetails === undefined ? {$exists:false} : a.accountDetails};
    const updated = await EpicAccount.findOneAndUpdate(match,{$set:set},{returnDocument:'after',runValidators:true}).select(projection).lean();
    if (!updated) return res.status(409).json({success:false,message:'Details changed in another window. Refresh before saving.'});
    res.json({success:true,account:view(updated)});
  } catch { res.status(500).json({success:false,message:'Could not save account details'}); }
});
router.post('/api/epic/accounts/:id/details/reveal', requireSuperadmin, validId, async (req,res) => {
  try {
    const a = await EpicAccount.findById(req.params.id).select('email password totpSecret').lean();
    if (!a) return res.status(404).json({success:false,message:'Account not found'});
    res.json({success:true,email:decrypt(a.email),password:decrypt(a.password),totpSecret:decrypt(a.totpSecret)});
  } catch { res.status(500).json({success:false,message:'Could not reveal credentials'}); }
});
module.exports = router;
