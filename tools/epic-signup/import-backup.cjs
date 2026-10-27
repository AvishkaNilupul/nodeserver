// One-time, local-only import of a legacy encrypted signup backup.
const fs=require('fs'),crypto=require('crypto'),dotenv=require('dotenv');
const {LocalVault}=require('./local-vault.cjs');const {DEFAULT_DIR}=require('./local-app.cjs');
function decryptLegacy(value,key){if(!value)return'';if(!value.startsWith('enc:v1:'))throw Error('Expected an encrypted legacy field');const[iv,tag,data]=value.slice(7).split(':');const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));d.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString();}
function importBackup({backupFile,legacyEnvFile,profileFile,dataDir=DEFAULT_DIR}){
 const env=dotenv.parse(fs.readFileSync(legacyEnvFile)),secret=env.CRED_SECRET||env.SESSION_SECRET;if(!secret)throw Error('Legacy credential key missing');
 const key=crypto.scryptSync(secret,'redeemer-cred-box',32),backup=JSON.parse(fs.readFileSync(backupFile,'utf8')),a=backup.account;
 const vault=new LocalVault(dataDir);if(vault.data.accounts.some(x=>x.accountId===a.accountId))return{imported:false,alreadyPresent:true};
 const profile=profileFile?JSON.parse(decryptLegacy(fs.readFileSync(profileFile,'utf8'),key)):{};
 vault.data.accounts.push({_id:crypto.randomBytes(12).toString('hex'),accountId:a.accountId,displayName:a.displayName,email:decryptLegacy(a.email,key),password:decryptLegacy(a.password,key),refreshToken:decryptLegacy(a.refreshToken,key),totpSecret:a.totpSecret?decryptLegacy(a.totpSecret,key):'',createdAt:a.createdAt||backup.createdAt,status:'imported',source:'local-backup',profile});vault.save();return{imported:true,displayName:a.displayName};
}
if(require.main===module){try{console.log(JSON.stringify(importBackup({backupFile:process.argv[2],legacyEnvFile:process.argv[3],profileFile:process.argv[4]})));}catch{console.error('Local backup import failed; source files were left unchanged');process.exitCode=1;}}
module.exports={importBackup};
