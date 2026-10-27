// Keep the former temporary test address useful without storing local accounts.
// Signup sessions and inventory now live on the authenticated production panel.
const http = require('http');
const target = 'https://redeemhub.lets.game/epic-accounts.html#claims';
http.createServer((req,res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.url.startsWith('/api/')) {
    res.writeHead(410,{'Content-Type':'application/json'});
    res.end(JSON.stringify({success:false,message:'This temporary test address has moved. Open '+target}));
  } else {res.writeHead(302,{Location:target});res.end();}
}).listen(4107,'127.0.0.1',()=>console.log('Epic signup shortcut listening on 127.0.0.1:4107'));
