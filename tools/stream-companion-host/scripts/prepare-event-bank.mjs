#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareEventBank } from '../lib/event-catalog.mjs';

export async function prepare(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: 'Usage: node scripts/prepare-event-bank.mjs --bank SAVED_BANK.json --output NEW_PRIVATE_DIRECTORY\nOffline proposal only; no controller calls or activation.' };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--bank', '--output'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw Error('Use --bank and --output once each.');
    args[argv[i]] = argv[i + 1];
  }
  if (!args['--bank'] || !args['--output']) throw Error('A saved bank and new private output directory are required.');
  const bytes = await readFile(args['--bank']);
  if (bytes.length > 1_000_000) throw Error('The saved bank input is too large.');
  const saved = JSON.parse(bytes.toString('utf8'));
  if (!Number.isSafeInteger(saved?.revision) || saved.revision < 1 || !saved.bank) throw Error('A saved bank with its current revision is required.');
  const result = prepareEventBank(saved.bank), output = resolve(args['--output']);
  await mkdir(output, { mode: 0o700 });
  const proposal = { expectedRevision: saved.revision, ...result.manifest,
    request: { requestId: `event-bank:${randomUUID()}`, expectedRevision: saved.revision, bank: result.bank },
    automaticActivation: false, generatedAt: new Date().toISOString() };
  await writeFile(resolve(output, 'candidate-bank.json'), `${JSON.stringify(result.bank, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(output, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { output, added: result.manifest.added, automaticActivation: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepare(process.argv.slice(2)).then(value => console.log(value.help || JSON.stringify(value))).catch(() => { console.error('The offline event-bank proposal could not be prepared. Check inputs and use a new output directory.'); process.exitCode = 1; });
}
