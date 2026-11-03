const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Queue}=require('./queue.cjs');
const {readGuard}=require('./guard.cjs');
const DEFAULT_DIR=path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker');
function createServer({directory=DEFAULT_DIR,port=4112,queue=new Queue(directory)}={}){
  const token=crypto.randomBytes(32).toString('base64url');
  const same=(a,b)=>typeof a==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
  const headers={'Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
  const reply=(res,status,data)=>{res.writeHead(status,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host;
      if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return reply(res,403,{ok:false,error:'Local access only'});
      const origin=req.headers.origin;
      if(origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(origin))return reply(res,403,{ok:false,error:'Local origin required'});
      if(req.headers['sec-fetch-site']==='cross-site')return reply(res,403,{ok:false,error:'Cross-site request denied'});
      const url=new URL(req.url,'http://'+host),files={'/':['index.html','text/html'],'/app.js':['app.js','application/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&files[url.pathname]){
        const [name,type]=files[url.pathname];let content=fs.readFileSync(path.join(__dirname,name),'utf8');
        if(name==='index.html')content=content.replace('__TOKEN__',token);
        res.writeHead(200,{...headers,'Content-Type':type+'; charset=utf-8'});return res.end(content);
      }
      if(req.method==='GET'&&url.pathname==='/health')return reply(res,200,{ok:true,service:'rivals-claim-worker'});
      if(!same(req.headers['x-local-token'],token))return reply(res,403,{ok:false,error:'Local token required'});
      if(req.method==='GET'&&url.pathname==='/api/state')return reply(res,200,{ok:true,...queue.status()});
      if(req.method!=='POST')return reply(res,404,{ok:false,error:'Not found'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(res,415,{ok:false,error:'JSON required'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>131072)return reply(res,413,{ok:false,error:'Request too large'});}
      let b;try{b=JSON.parse(raw||'{}');}catch{return reply(res,400,{ok:false,error:'Invalid JSON'});}
      let result;
      if(url.pathname==='/api/import')result=queue.import(b);
      else if(url.pathname==='/api/acquire')result=queue.acquire(b.owner,b.id);
      else if(url.pathname==='/api/enabled')result=queue.pause(b.enabled);
      else{
        const m=url.pathname.match(/^\/api\/jobs\/([\w-]{8,100})\/(observe|heartbeat|block|resume|credential|begin-login|guard)$/);
        if(!m)return reply(res,404,{ok:false,error:'Not found'});
        const [,id,action]=m;
        if(action==='observe')result=queue.record(id,b.leaseToken,b.revision,b.observation);
        if(action==='heartbeat')result=queue.heartbeat(id,b.leaseToken);
        if(action==='block')result=queue.block(id,b.leaseToken,b.reason);
        if(action==='resume')result=queue.resume(id);
        if(action==='begin-login')result=queue.beginLogin(id,b.leaseToken);
        if(action==='guard'){
          if(b.copy!==true)return reply(res,400,{ok:false,error:'Explicit code copy required'});
          result={value:await readGuard(queue.loginContext(id))};
        }
        if(action==='credential'){
          if(b.copy!==true)return reply(res,400,{ok:false,error:'Explicit credential copy required'});
          result={value:queue.secret(id,b.key)};
        }
      }
      reply(res,200,{ok:true,result});
    }catch(e){reply(res,e.status||500,{ok:false,error:e.status?e.message:'Worker operation failed; saved data was preserved'});}
  });
  return {server,queue,token};
}
if(require.main===module){const {server}=createServer();server.listen(4112,'127.0.0.1',()=>console.log('Rivals claim desk: http://127.0.0.1:4112'));}
module.exports={createServer,DEFAULT_DIR};
