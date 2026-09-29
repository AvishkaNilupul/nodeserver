const fs = require('node:fs');
const path = require('node:path');
const { PaperEngine } = require('./lib/paper-engine');

function replay(inputFile, config) {
  const outputDir = path.join(__dirname, 'runs', `replay-${Date.now()}`);
  const engine = new PaperEngine(config, outputDir);
  for (const line of fs.readFileSync(inputFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'market') engine.onMarketEvent(event);
  }
  console.log(JSON.stringify({ outputDir, ...engine.summary() }, null, 2));
}

module.exports = { replay };
