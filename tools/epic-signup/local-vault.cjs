const fs=require('fs'),path=require('path'),crypto=require('crypto');
class LocalVault {
  constructor(directory) {
    this.directory=directory;fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
    this.filename=path.join(directory,'accounts.vault');const keyfile=path.join(directory,'vault.key');
    if(!fs.existsSync(keyfile)) {
      if(fs.existsSync(this.filename))throw Error('Vault key is missing; restore it before starting');
      fs.writeFileSync(keyfile,crypto.randomBytes(32),{flag:'wx',mode:0o600});
    }
    this.key=fs.readFileSync(keyfile);if(this.key.length!==32)throw Error('Invalid local vault key');fs.chmodSync(keyfile,0o600);
    this.data={version:1,sessions:[],accounts:[]};
    if(fs.existsSync(this.filename)) {
      const saved=JSON.parse(fs.readFileSync(this.filename,'utf8'));
      const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(saved.iv,'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag,'base64'));
      const plain=Buffer.concat([decipher.update(Buffer.from(saved.data,'base64')),decipher.final()]);
      this.data=JSON.parse(plain.toString());
      if(this.data.version!==1||!Array.isArray(this.data.sessions)||!Array.isArray(this.data.accounts))throw Error('Invalid local vault contents');
      fs.chmodSync(this.filename,0o600);
    }
  }
  save() {
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
    const data=Buffer.concat([cipher.update(JSON.stringify(this.data),'utf8'),cipher.final()]);
    const temporary=this.filename+'.'+process.pid+'.tmp';
    const fd=fs.openSync(temporary,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,this.filename);
  }
}
module.exports={LocalVault};
