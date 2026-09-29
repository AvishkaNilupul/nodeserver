const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

if (process.argv[2] === 'replay') {
  require('./replay').replay(process.argv[3], config);
} else if (process.argv[2] === 'live') {
  require('./live').live(config);
} else {
  console.error('Usage: node tools/pump-paper-bot/index.js replay <events.jsonl> | live');
  process.exitCode = 1;
}
