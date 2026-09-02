// One-time (idempotent) seed of the AI coworker's long-term memory with a
// domain primer, so it starts each session already knowing how this operation
// works. Safe to re-run — memories upsert by key. Run: node scripts/seed-coworker-memory.js
require("dotenv").config();
const mongoose = require("mongoose");
const config = require("../config/config");
const CoworkerMemory = require("../models/CoworkerMemory");

const SEED = [
  { key: "domain-pipeline", topic: "domain", pinned: true, text: "Pipeline: bots farm Twitch drops on pooled accounts → drops become sellable sets/bundles → listed & priced across marketplaces → buyers order, accounts delivered. An auto-farm engine picks games by demand/coverage." },
  { key: "hosts", topic: "domain", pinned: true, text: "Bots run on two hosts only: 'server' (local, this box) and 'pi' (a Raspberry Pi). The old 'phone' host was retired. Bots read config at startup; a config change needs a container restart on the host." },
  { key: "known-noise", topic: "ops", pinned: true, text: "Routine log noise that is NOT a failure: telegramBot poll errors (502/timeout), gameflip relist retries ('code for digital goods already exists'), 'campaignWatcher error: failed integrity check', Mongoose deprecation warnings. Don't flag these unless asked." },
  { key: "autofarm-capacity-cap", topic: "farming", pinned: false, text: "'A new event isn't being farmed' is often the maxAutoBots soft cap (events log skip_no_capacity / 'no capacity'), not a bug. It's a policy ceiling; raising capacity is an operator decision." },
  { key: "bot-stall-decay", topic: "bots", pinned: false, text: "'Some accounts farm, some don't' on a long-running bot is usually watcher threads decaying over days of uptime, not overload. A container restart revives all threads. Recurring auto-restarts on the same container (e.g. twitchbotx24 on pi) are worth flagging as chronic." },
  { key: "ban-wave-vs-leak", topic: "pool", pinned: false, text: "Twitch bans accounts in waves; ~20% of fresh accounts get suspended within days. A falling pool-available with a FLAT total fleet = a ban/suspension sweep, not a leak in our code." },
  { key: "pricing-floor", topic: "pricing", pinned: false, text: "DropSet.minPriceUsd is the price floor per set — a relist inherits its predecessor's price, so the floor is the only guard. Manual/hand-made listings (MarketplaceListing.origin) are intentionally NEVER auto-repriced." },
  { key: "scanner-lag", topic: "farming", pinned: false, text: "'The bot didn't farm X' is often drop-scanner lag rather than a real miss; 'bad tokens' reports are frequently transient false positives. Verify with drop_logs / event timing before concluding an account is broken." },
  { key: "marketplaces", topic: "marketplaces", pinned: false, text: "Publish targets: plati, ggsel, zeusx, digiseller, g2g, funpay, z2u. Digiseller has no edit API (text changes require republishing). Compare pricing/stock across them via marketplace_listings (db_group by marketplace)." },
  { key: "noclaim-bots", topic: "farming", pinned: false, text: "No-claim bots farm but deliberately don't claim (games: Overwatch, R6, Call of Duty), running on the Pi. An idle no-claim bot logging 'no campaigns / removing finished campaigns' means FINISHED, not broken — verify by inventory percent." },
  { key: "propose-only", topic: "ops", pinned: true, text: "You are propose-only: you cannot edit code, reprice, or change prod. File concrete recommendations with the propose tool (for code: exact file + before/after). The operator reviews and applies." },
];

(async () => {
  await mongoose.connect(config.MONGO_URI);
  let n = 0;
  for (const m of SEED) {
    await CoworkerMemory.updateOne(
      { key: m.key },
      { $set: { topic: m.topic, text: m.text, pinned: m.pinned, source: "seed", updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    n++;
  }
  console.log(`seeded/updated ${n} coworker memories`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("seed error:", e.message); process.exit(1); });
