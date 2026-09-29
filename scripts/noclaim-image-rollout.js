#!/usr/bin/env node
// Roll a TwitchDropsBot build out to every no-claim bot (noclaim-bot-*).
//
// The no-claim fleet has no Bots-page rollout: its image is only built when it
// is missing, so a bot fix pushed to the fork never reaches bots that already
// exist. This drives utils/noclaimFleet.rolloutImage: build the ref on the
// no-claim host, sanity-test it on a copy of a stopped bot's config (it must
// log the no-claim guard line — a build that would claim is refused), promote
// it (the previous build is kept as twitchbot-noclaim:pre-<stamp>), then
// recreate stopped bots without starting them and running bots one at a time
// with a health check.
//
// Run ON PROD (it needs the bot-host SSH key and config/botHosts.json):
//   node scripts/noclaim-image-rollout.js --dry-run            # build + test only
//   node scripts/noclaim-image-rollout.js --ref farm-20260929b
// --ref defaults to the fork branch the fleet builds from (noclaim-test).
require("dotenv").config({ quiet: true });

const fleet = require("../utils/noclaimFleet");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const ref = arg("ref") || fleet.BRANCH;
  const dryRun = process.argv.includes("--dry-run");
  const stamp = () => new Date().toISOString().slice(11, 19);
  console.log(`${stamp()} no-claim image rollout: ${fleet.REPO} @ ${ref}${dryRun ? " (dry run)" : ""}`);
  const result = await fleet.rolloutImage({
    ref,
    dryRun,
    log: (m) => console.log(`${stamp()} ${m}`),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("FAILED: " + (e && e.message ? e.message : e));
  process.exit(1);
});
