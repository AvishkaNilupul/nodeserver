#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareStyleBank, reviewHistory } from '../lib/style-review.mjs';

const HELP = `Prepare an offline, account-specific message-bank proposal.
Usage: node scripts/review-chat-style.mjs --bank BANK.json --history HISTORY.json --output NEW_DIRECTORY [--feedback FEEDBACK.json]

BANK is a saved bank or { revision, bank }. HISTORY is an array or { history }.
Optional feedback is { avoidTextKeys: [reviewed 16-hex normalized text keys] }.
The output directory must be new. It contains private review.json, candidate-bank.json,
and proposal.json. This command never contacts the controller, changes the running
bank, starts an account, or sends a message. Preserve the original input evidence.`;

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--bank', '--history', '--output', '--feedback'].includes(flag) || !value || value.startsWith('--') || args[flag]) {
      throw new Error('Use --bank, --history, --output, and optional --feedback once each.');
    }
    args[flag] = value;
  }
  if (!args['--bank'] || !args['--history'] || !args['--output']) throw new Error('Bank, history, and a new output directory are required.');
  return args;
}

async function jsonFile(path) {
  let bytes;
  try { bytes = await readFile(path); } catch { throw new Error('An input file could not be read.'); }
  if (bytes.length > 32 * 1024 * 1024) throw new Error('An input file exceeds the offline review limit.');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('An input file is not valid JSON.'); }
}

export async function runReview(argv) {
  const args = parseArguments(argv);
  if (args.help) return { help: HELP };
  const [saved, historyInput, feedback] = await Promise.all([
    jsonFile(args['--bank']), jsonFile(args['--history']),
    args['--feedback'] ? jsonFile(args['--feedback']) : Promise.resolve({ avoidTextKeys: [] })
  ]);
  const bank = saved?.bank || saved;
  const history = Array.isArray(historyInput) ? historyInput : historyInput?.history;
  if (!Array.isArray(history)) throw new Error('History must contain a canonical outgoing-history array.');
  if (!feedback || Array.isArray(feedback) || typeof feedback !== 'object'
    || Object.keys(feedback).length !== 1 || !Array.isArray(feedback.avoidTextKeys)
    || feedback.avoidTextKeys.length > 1000 || feedback.avoidTextKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key))) {
    throw new Error('Feedback must contain only reviewed avoidTextKeys.');
  }
  const result = prepareStyleBank(bank, feedback), review = reviewHistory({ history, bank, negativeFeedbackKeys: feedback.avoidTextKeys });
  const revision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : null;
  const generatedAt = new Date().toISOString(), output = resolve(args['--output']);
  // A new directory and exclusive files make this a proposal, never an update
  // to evidence, a live message bank, or a credential file supplied by mistake.
  await mkdir(output, { mode: 0o700 });
  const files = {
    'candidate-bank.json': result.bank,
    'review.json': { version: 1, generatedAt, referenceRevision: revision, inputCapturedAt: historyInput?.capturedAt || null, review },
    'proposal.json': { version: 1, generatedAt, referenceRevision: revision, ...result.manifest,
      explicitFeedbackKeys: [...feedback.avoidTextKeys], liveApplied: false,
      activation: 'Use the existing revision-checked bank Save after the observed run. Recheck source-bank fingerprint and preserve history, scopes, profiles, and consumed opportunities.' }
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { output, referenceRevision: revision, entries: result.bank.entries.length, accounts: result.bank.profiles.length, liveApplied: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReview(process.argv.slice(2)).then(result => console.log(result.help || JSON.stringify(result))).catch(error => {
    console.error(error?.message || 'The offline review could not be prepared.');
    process.exitCode = 1;
  });
}
