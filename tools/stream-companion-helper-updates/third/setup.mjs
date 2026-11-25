import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

await mkdir(new URL('./private/',import.meta.url),{recursive:true,mode:0o700});
await chmod(new URL('./private/',import.meta.url),0o700);
const manifestUrl=new URL('./extension/manifest.json',import.meta.url);
const manifest=JSON.parse(await readFile(manifestUrl,'utf8'));
if (!manifest.key) {
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'der'}});
  manifest.key=publicKey.toString('base64');
  await writeFile(manifestUrl,JSON.stringify(manifest,null,2)+'\n');
}
const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16).toString('hex').replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const configUrl=new URL('./private/config.json',import.meta.url);
let old={};try{old=JSON.parse(await readFile(configUrl,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(configUrl,JSON.stringify({baseUrl:'https://api.openai.com/v1',apiStyle:'responses',model:'',apiKey:'',...old,extensionId:id,pairingToken:old.pairingToken || randomBytes(32).toString('hex')},null,2)+'\n',{mode:0o600});
await chmod(configUrl,0o600);
console.log(`Prepared extension ${id}. Provider configuration and pairing token: private/config.json`);
