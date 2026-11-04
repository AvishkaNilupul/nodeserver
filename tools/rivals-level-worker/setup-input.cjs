'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const version='0.17.1';
async function setup(root=process.env.RIVALS_LEVEL_DIR||path.join(os.homedir(),'Library/Application Support/RivalsLevelWorker')){
 const directory=path.join(root,'toolchain');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const architecture=process.arch==='arm64'?'aarch64-macos':'x86_64-macos',name=`zig-${architecture}-${version}`,zig=path.join(directory,name,'zig');
 if(!fs.existsSync(zig)){
  const response=await fetch('https://ziglang.org/download/index.json');if(!response.ok)throw Error('Official Zig metadata unavailable');
  const metadata=(await response.json())[version]?.[architecture];if(!metadata||!/^https:\/\/ziglang.org\//.test(metadata.tarball))throw Error('Pinned official toolchain unavailable');
  const r=await fetch(metadata.tarball);if(!r.ok)throw Error('Toolchain download failed');const data=Buffer.from(await r.arrayBuffer());
  if(crypto.createHash('sha256').update(data).digest('hex')!==metadata.shasum)throw Error('Toolchain checksum mismatch');
  const archive=path.join(directory,'zig.tar.xz');fs.writeFileSync(archive,data,{mode:0o600});
  const extracted=spawnSync('tar',['-xf',archive,'-C',directory],{stdio:'inherit'});if(extracted.status!==0)throw Error('Toolchain extraction failed');
  fs.writeFileSync(path.join(directory,'zig-provenance.json'),JSON.stringify({version,architecture,source:metadata.tarball,sha256:metadata.shasum}),{mode:0o600});
 }
 const binary=path.join(root,'win-input.exe'),r=spawnSync(zig,['cc','-target','x86_64-windows-gnu','-municode','-Wl,--subsystem,windows',path.join(__dirname,'win-input.c'),'-o',binary,'-lshell32','-luser32','-Os','-Wall','-Wextra'],{stdio:'inherit',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(directory,'cache')}});
 if(r.status!==0)throw Error('Windows input helper compilation failed');fs.chmodSync(binary,0o600);
 fs.writeFileSync(path.join(root,'input-build.json'),JSON.stringify({version,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'win-input.c'))).digest('hex'),binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),builtAt:new Date().toISOString()}),{mode:0o600});
 console.log(JSON.stringify({ok:true,binary,compiler:version}));
}
if(require.main===module)setup().catch(e=>{console.error(e.message);process.exitCode=1});module.exports={setup};
