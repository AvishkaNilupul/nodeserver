const path = require('path');
const root = process.env.OUTLOOK_RUNTIME_ROOT || '/opt/redeemer-outlook';
require(path.join(root, 'node_modules/dotenv')).config({path:path.join(root,'runtime.env'),quiet:true});
const common = {cwd:root,instances:1,exec_mode:'fork',autorestart:true,
  env:{OUTLOOK_ACCOUNTS_FILE:path.join(root,'data/outlooks.txt'),OUTLOOK_USAGE_FILE:path.join(root,'data/mail-usage.json'),
    RES_HOST:process.env.RES_HOST,RES_PORT:process.env.RES_PORT,RES_USER:process.env.RES_USER,RES_PASS:process.env.RES_PASS}};
module.exports = {apps:[
  {...common,name:'outlook-pool',script:path.join(root,'scripts/mail-dashboard.js')},
  {...common,name:'outlook-buyer-mail',script:path.join(root,'scripts/epic-mail-proxy.js'),env:{
    EPIC_MAIL_PROXY_TOKEN:process.env.EPIC_MAIL_PROXY_TOKEN,EPIC_MAIL_PROXY_PORT:'18124',
    EPIC_MAIL_PROXY_OUTLOOKS:path.join(root,'data/outlooks.txt'),EPIC_MAIL_PROXY_USAGE:path.join(root,'data/mail-usage.json')}}
]};
