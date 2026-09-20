#!/usr/bin/env node
// Move one bot config (and its accounts) from one host to another.
//
// WHY THIS EXISTS
// Nothing in the codebase does a cross-host move end to end:
//   * POST /bot-configs/move copies the config + compose service and starts the
//     container, but never repoints BotAccount and leaves the source config in
//     place — so the next host reboot starts the same accounts a second time.
//   * utils/botConsolidator does the FavouriteGames pinning and the correct
//     BotAccount triple-stamp, but takes a single hostId and hard-drops
//     anything not on it (collectAutoContainers/collectNamedContainers/
//     reconcileTaskBots all filter on host.id).
//   * utils/dupeGuard.enforceSingleHome only sweeps siblings on ONE host, so it
//     cannot see the same ClientSecret enabled on two hosts at once.
// This stitches those together and adds the source teardown.
//
// USAGE (run on the prod server, from the app root):
//   node scripts/move-bot-host.js --cfg config_45.json --from pi --to contabo
//   ... add --apply to actually do it. Without it, nothing is written.
//
// SAFETY
//   * Stops the SOURCE container before the destination starts, so an account
//     is never live on two hosts (the one failure mode that gets accounts banned).
//   * Pins inherited config-level FavouriteGames onto enabled blank accounts
//     BEFORE they leave — otherwise they silently adopt the destination
//     config's game list. Disabled blanks keep [] (the retirement marker).
//   * Validates the destination compose file before starting anything: other
//     people's live containers share it.
//   * Retires the source config by rename, never delete.
const path = require("path");
const APP = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(APP, ".env") });
const mongoose = require("mongoose");
const yaml = require("js-yaml");
const hosts = require(path.join(APP, "utils", "botHosts"));
const cons = require(path.join(APP, "utils", "botConsolidator"));
const settings = require(path.join(APP, "utils", "settings"));
const bc = require(path.join(APP, "routes", "botConfigRoutes"));
const BotAccount = require(path.join(APP, "models", "BotAccount"));
const AutoFarmTask = require(path.join(APP, "models", "AutoFarmTask"));

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const APPLY = process.argv.includes("--apply");
const FILE = arg("cfg");
const SRC_ID = arg("from", "pi");
const DST_ID = arg("to", "contabo");
const IMAGE = arg("image", "avishkarex/twitchbot:latest");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const p = (...a) => console.log("  ", ...a);

async function main() {
  if (!FILE || !bc.validFile(FILE)) throw new Error("--cfg <config_NN.json> is required");
  const CONTAINER = bc.containerForFile(FILE);
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const src = hosts.resolveHost(SRC_ID);
  const dst = hosts.resolveHost(DST_ID);
  if (!src || !dst) throw new Error("unknown host id");
  if (src.id === dst.id) throw new Error("source and destination are the same host");
  console.log(`== ${src.id}:${FILE} (${CONTAINER}) -> ${dst.id}   APPLY=${APPLY}`);

  const data = JSON.parse(await hosts.readFile(src, FILE));
  const rawUsers = (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
  const { users, materialized } = cons.materializeGames(rawUsers, data.FavouriteGames);
  const enabled = users.filter((u) => u.Enabled !== false).length;
  p(`source: ${users.length} entries (${enabled} enabled), pinned inherited games onto ${materialized}`);
  if (!users.length) throw new Error("source config has no accounts — nothing to move");

  const secrets = users.map((u) => u.ClientSecret).filter(Boolean);
  if (new Set(secrets).size !== secrets.length) throw new Error("duplicate ClientSecret inside source config");
  const onDst = await BotAccount.countDocuments({ clientSecret: { $in: secrets }, host: dst.id });
  if (onDst) throw new Error(`REFUSING: ${onDst} of these accounts are already registered on ${dst.id}`);
  if ((await hosts.readdir(dst)).includes(FILE)) throw new Error(`REFUSING: ${FILE} already exists on ${dst.id}`);
  const dstPs = await hosts.dockerPs(dst);
  if (dstPs && dstPs[CONTAINER]) throw new Error(`REFUSING: ${CONTAINER} already exists on ${dst.id}`);
  p(`preflight ok — no file, container or account collision on ${dst.id}`);

  const composeName = await hosts.composeName(dst);
  if (!composeName) throw new Error(`no compose file in ${dst.dir}`);
  const composeRaw = await hosts.composeRead(dst, composeName);
  const composeDoc = yaml.load(composeRaw) || {};

  if (!APPLY) return p("DRY RUN — no changes made (pass --apply)");

  const prior = settings.getAutoFarm();
  await settings.setAutoFarm({ enabled: false });
  p(`auto-farm paused (was enabled=${prior.enabled})`);
  try {
    await hosts.dockerContainer(src, "stop", CONTAINER).catch((e) => p("stop warn: " + e.message));
    p(`${src.id}/${CONTAINER} stopped`);

    const shell = JSON.parse(JSON.stringify(data));
    shell.TwitchSettings.TwitchUsers = [];
    if (shell.KickSettings) shell.KickSettings.KickUsers = [];
    await hosts.writeFileAtomic(dst, FILE, JSON.stringify(shell, null, 2));
    p(`${dst.id}/${FILE} created (empty)`);

    await hosts.composeWrite(dst, `${composeName}.bak-${stamp}`, composeRaw);
    composeDoc.services = composeDoc.services || {};
    composeDoc.services[CONTAINER] = {
      image: IMAGE,
      container_name: CONTAINER,
      restart: "always",
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      volumes: [`./${FILE}:/app/config.json`, "./logs:/app/logs"],
    };
    await hosts.composeWrite(dst, composeName, yaml.dump(composeDoc, { lineWidth: -1 }));
    const check = await hosts.runShell(dst, `cd ${hosts.shq(dst.dir)} && docker compose config -q && echo COMPOSE_OK`);
    if (!String((check && check.stdout) || check).includes("COMPOSE_OK")) {
      throw new Error("destination compose failed validation — restore from " + composeName + ".bak-" + stamp);
    }
    p(`compose service ${CONTAINER} added and validated`);

    // Entries move verbatim: addAccountsToConfig preserves each account's own
    // FavouriteGames (botFactory.addAccountsToBot would flatten them to one
    // game) and stamps host/configFile/container on BotAccount for us.
    const r = await bc.addAccountsToConfig(dst, FILE, users);
    const back = JSON.parse(await hosts.readFile(dst, FILE));
    const n = ((back.TwitchSettings || {}).TwitchUsers || []).length;
    if (n !== users.length) throw new Error(`read-back mismatch: expected ${users.length}, got ${n}`);
    p(`entries written and read back: added=${r.added} total=${n}`);

    await hosts.composeUp(dst, CONTAINER);
    p(`${dst.id}/${CONTAINER} started`);

    await hosts.dockerContainer(src, "rm", CONTAINER).catch((e) => p("rm warn: " + e.message));
    const srcComposeName = await hosts.composeName(src);
    if (srcComposeName) {
      const srcRaw = await hosts.composeRead(src, srcComposeName);
      await hosts.composeWrite(src, `${srcComposeName}.bak-${stamp}`, srcRaw);
      const srcDoc = yaml.load(srcRaw) || {};
      if (srcDoc.services) delete srcDoc.services[CONTAINER];
      await hosts.composeWrite(src, srcComposeName, yaml.dump(srcDoc, { lineWidth: -1 }));
    }
    await hosts.rename(src, FILE, `${FILE}.done-${stamp}`);
    p(`${src.id}: container removed, compose service dropped, config retired as ${FILE}.done-${stamp}`);

    // AutoFarmTask.bots[] carries its own host — reconcileTaskBots only rebuilds
    // one host's entries, so a cross-host move has to repoint them here.
    const t = await AutoFarmTask.updateMany(
      { status: { $in: ["executed", "running", "active"] }, "bots.container": CONTAINER, "bots.host": src.id },
      { $set: { "bots.$[b].host": dst.id } },
      { arrayFilters: [{ "b.container": CONTAINER, "b.host": src.id }] },
    );
    p(`AutoFarmTask bots repointed: modified=${t.modifiedCount}`);
    p(`BotAccount now on ${dst.id}: ${await BotAccount.countDocuments({ clientSecret: { $in: secrets }, host: dst.id })}/${secrets.length}`);
  } finally {
    await settings.setAutoFarm({ enabled: prior.enabled });
    p(`auto-farm restored to enabled=${prior.enabled}`);
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; return mongoose.disconnect(); });
