#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { readPrivate, writePrivate, acquireRuntimeLock } = require('../utils/z2u/privateStore');
const { importBrowserSession } = require('../utils/z2u/session');
const { createZ2uClient } = require('../utils/z2u/client');
const { verifyAccess, loadConfig, connect, runCheck, monitor, safeCode } = require('../utils/z2u/runtime');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const { stockOffer, reconcileOffer } = require('../utils/z2u/engine');

async function openAllocator(ledger, adoptedOffers) {
  // Loaded only for adopted real stock, never for the session/access probe.
  require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  if (!process.env.MONGO_URI) throw new Error('DATABASE_UNCONFIGURED');
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  try {
    const { createZ2uStockAdapter } = require('../utils/z2u/stock');
    return { adapter: createZ2uStockAdapter({ ledger, adoptedOffers }), close: () => mongoose.disconnect() };
  } catch (error) { await mongoose.disconnect(); throw error; }
}

async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  if (command === '--help' || !command) {
    console.log('Usage: node scripts/z2u-runtime.js import-session --state-dir /private/z2u --source /private/cookies.json\n       node scripts/z2u-runtime.js check|run --state-dir /private/z2u\n       node scripts/z2u-runtime.js run --state-dir /private/z2u --launch-offer ID\n       node scripts/z2u-runtime.js stock|prepare-stock --state-dir /private/z2u --offer ID --count 1 --batch UNIQUE_ID\nStock requires an exact adopted offer in private config.json and the production allocator. Stop the worker before session import or stocking. prepare-stock initializes a newly created empty vault while its exact offer stays paused. Only run --launch-offer explicitly activates one verified unit once. No command manually delivers or releases uncertain stock.'); return;
  }
  if (!['import-session', 'check', 'run', 'stock', 'prepare-stock'].includes(command) || args.length % 2) throw new Error('INVALID_ARGUMENTS');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--state-dir', '--source', '--offer', '--count', '--batch', '--launch-offer'].includes(args[i]) || options[args[i]]) throw new Error('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  const stateDir = options['--state-dir'] || process.env.Z2U_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('PRIVATE_PATH_REQUIRED');
  if (options['--launch-offer'] && (command !== 'run' || !/^[1-9]\d*$/.test(options['--launch-offer']))) throw new Error('INVALID_ARGUMENTS');
  const unlock = await acquireRuntimeLock(path.join(stateDir, 'runtime.lock'));
  let allocator;
  try {
    if (command === 'import-session') {
      if (!options['--source']) throw new Error('SOURCE_REQUIRED');
      const exported = await readPrivate(options['--source']);
      const result = await importBrowserSession(path.join(stateDir, 'session.json'), exported,
        session => verifyAccess(createZ2uClient(session)));
      console.log(JSON.stringify(result)); return;
    }
    const ledger = openVaultLedger(path.join(stateDir, 'vault-ledger.json'));
    const ledgerOwner = await ledger.inspectLock();
    if (ledgerOwner) await ledger.recoverDeadLock(ledgerOwner.token);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const allocatorFor = async config => { if (!allocator) allocator = await openAllocator(ledger, config.offers); return allocator.adapter; };
    if (command === 'stock' || command === 'prepare-stock') {
      try {
        const config = await loadConfig(stateDir);
        const offer = config.offers.find(item => item.offerId === options['--offer']);
        if (!offer || !/^[1-5]$/.test(options['--count'] || '') || !options['--batch']) throw new Error('INVALID_STOCK_REQUEST');
        const { protocol } = await connect(stateDir, { signal: controller.signal });
        const verifyDedicatedStorage = async () => require('../utils/z2u/dedicatedStorage').verifyDedicatedStorage({
          protocol, offer, provenance: await readPrivate(path.join(stateDir, 'storage-provenance.json')),
          parseDocument: require('../utils/z2u/runtime').parseDocument });
        console.log(JSON.stringify(await stockOffer({ protocol, ledger, stockAdapter: await allocatorFor(config), offer,
          count: Number(options['--count']), batchId: options['--batch'], prepare: command === 'prepare-stock', verifyDedicatedStorage })));
        return;
      } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
    }
    let cycleConnection, cycleConfig, launchAttempted = false;
    const cycle = async ({ signal = controller.signal } = {}) => {
      let previous = {}; try { previous = await readPrivate(path.join(stateDir, 'health.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let connection;
      try { connection = await connect(stateDir, { signal }); }
      catch (error) {
        connection = { client: { readPage: async () => { throw error; } } };
      }
      const config = await loadConfig(stateDir);
      cycleConnection = connection; cycleConfig = config;
      return runCheck({ stateDir, ...connection, config, previous, signal,
        checkOffer: async offer => reconcileOffer({ protocol: connection.protocol, ledger, stockAdapter: await allocatorFor(config), offer }) });
    };
    try {
      if (command === 'check') { const status = await cycle(); console.log(JSON.stringify(status)); if (!status.healthy) process.exitCode = 2; }
      else await monitor({ cycle, signal: controller.signal, onStatus: async status => {
        console.log(JSON.stringify(status));
        if (!options['--launch-offer'] || launchAttempted || controller.signal.aborted) return;
        launchAttempted = true;
        let result;
        try {
          const offer = cycleConfig.offers.find(item => item.offerId === options['--launch-offer']);
          if (!offer) throw new Error('OFFER_UNVERIFIED');
          result = await require('../utils/z2u/workerLaunch').launchFromWorker({ stateDir, ...cycleConnection,
            ledger, stockAdapter: await allocatorFor(cycleConfig), offer, signal: controller.signal });
        } catch (error) {
          const codes = new Set(['ACTIVATION_ALREADY_ATTEMPTED', 'LAUNCH_UNVERIFIED', 'WRITE_UNCERTAIN', 'ABORTED']);
          result = { verified: false, code: codes.has(error.code) ? error.code : 'LAUNCH_UNVERIFIED', deactivationVerified: error.deactivationVerified === true };
        }
        await writePrivate(path.join(stateDir, 'launch-result.json'), result);
        console.log(JSON.stringify({ event: 'explicit_launch', ...result }));
        if (!controller.signal.aborted) console.log(JSON.stringify(await cycle()));
      } });
    } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  } finally { try { if (allocator) await allocator.close(); } finally { await unlock(); } }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, code: safeCode(error) })); process.exitCode = 1; });
module.exports = { main };
