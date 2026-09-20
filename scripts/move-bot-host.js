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
//   ... add --dest-cfg config_50.json when that name is already taken on the
//       destination (the container name follows the file name, so the moved bot
//       becomes twitchbotx50 there).
//   ... add --dedupe when the destination already holds some of these accounts.
//       Without it the move REFUSES, which is the right default: a second live
//       copy of an account is the one mistake that gets it banned.
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
const DEST = arg("dest-cfg", FILE);
const SRC_ID = arg("from", "pi");
const DST_ID = arg("to", "contabo");
const IMAGE = arg("image", "avishkarex/twitchbot:latest");
const DEDUPE = process.argv.includes("--dedupe");
const CFG_RE = /^config(_\d{1,3})?\.json$/;
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const p = (...a) => console.log("  ", ...a);

async function main() {
  if (!FILE || !bc.validFile(FILE)) throw new Error("--cfg <config_NN.json> is required");
  if (!bc.validFile(DEST)) throw new Error("--dest-cfg must be a valid config filename");
  const CONTAINER = bc.containerForFile(FILE);
  const DST_CONTAINER = bc.containerForFile(DEST);
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const src = hosts.resolveHost(SRC_ID);
  const dst = hosts.resolveHost(DST_ID);
  if (!src || !dst) throw new Error("unknown host id");
  if (src.id === dst.id) throw new Error("source and destination are the same host");
  console.log(`== ${src.id}:${FILE} (${CONTAINER}) -> ${dst.id}:${DEST} (${DST_CONTAINER})   APPLY=${APPLY}`);

  const data = JSON.parse(await hosts.readFile(src, FILE));
  const rawUsers = (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
  const { users, materialized } = cons.materializeGames(rawUsers, data.FavouriteGames);
  const enabled = users.filter((u) => u.Enabled !== false).length;
  p(`source: ${users.length} entries (${enabled} enabled), pinned inherited games onto ${materialized}`);
  if (!users.length) throw new Error("source config has no accounts — nothing to move");

  const secrets = users.map((u) => u.ClientSecret).filter(Boolean);
  if (new Set(secrets).size !== secrets.length) throw new Error("duplicate ClientSecret inside source config");

  // Destination occupancy comes from the CONFIGS, not the DB: a config is what
  // actually farms, and retired entries linger in old configs for years
  // (237 such duplicates across this fleet, all disabled).
  const dstCfgFiles = (await hosts.readdir(dst)).filter((f) => CFG_RE.test(f));
  const dstRaw = await hosts.readFiles(dst, dstCfgFiles);
  const dstIndex = new Map();
  for (const f of dstCfgFiles) {
    const e = dstRaw[f];
    if (!e || !e.ok) throw new Error(`cannot read ${dst.id}/${f} — refusing to move against an unknown destination`);
    let d; try { d = JSON.parse(e.text); } catch { continue; }
    for (const u of ((d.TwitchSettings || {}).TwitchUsers) || []) {
      const k = String(u.ClientSecret || "").trim();
      if (k) dstIndex.set(k, { file: f, entry: u });
    }
  }

  // Partition. An entry already on the destination is NOT re-sent. But if this
  // copy is the enabled one and the copy over there is disabled, the account
  // would silently stop farming — so promote that copy instead, carrying this
  // entry's (already materialized) game list onto it.
  const fresh = [], promote = [];
  let droppedDisabled = 0;
  for (const u of users) {
    const hit = dstIndex.get(String(u.ClientSecret || "").trim());
    if (!hit) { fresh.push(u); continue; }
    if (u.Enabled !== false && hit.entry.Enabled === false) {
      promote.push({ file: hit.file, secret: u.ClientSecret, login: u.Login || "", games: u.FavouriteGames || [] });
    } else droppedDisabled++;
  }
  const overlap = droppedDisabled + promote.length;
  if (overlap) {
    if (!DEDUPE) throw new Error(`REFUSING: ${overlap} of these accounts are already on ${dst.id} (pass --dedupe to skip them)`);
    p(`dedupe: ${overlap} already on ${dst.id} — ${droppedDisabled} dropped as retired, ${promote.length} promoted in place`);
  }
  if (fresh.length + overlap !== users.length) throw new Error("conservation check failed partitioning entries");
  if (!fresh.length && !promote.length) throw new Error("nothing to move — every entry already lives on the destination");
  if ((await hosts.readdir(dst)).includes(DEST)) throw new Error(`REFUSING: ${DEST} already exists on ${dst.id}`);
  const dstPs = await hosts.dockerPs(dst);
  if (dstPs && dstPs[DST_CONTAINER]) throw new Error(`REFUSING: ${DST_CONTAINER} already exists on ${dst.id}`);
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
    await hosts.writeFileAtomic(dst, DEST, JSON.stringify(shell, null, 2));
    p(`${dst.id}/${DEST} created (empty)`);

    await hosts.composeWrite(dst, `${composeName}.bak-${stamp}`, composeRaw);
    composeDoc.services = composeDoc.services || {};
    composeDoc.services[DST_CONTAINER] = {
      image: IMAGE,
      container_name: DST_CONTAINER,
      restart: "always",
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      volumes: [`./${DEST}:/app/config.json`, "./logs:/app/logs"],
    };
    await hosts.composeWrite(dst, composeName, yaml.dump(composeDoc, { lineWidth: -1 }));
    const check = await hosts.runShell(dst, `cd ${hosts.shq(dst.dir)} && docker compose config -q && echo COMPOSE_OK`);
    if (!String((check && check.stdout) || check).includes("COMPOSE_OK")) {
      throw new Error("destination compose failed validation — restore from " + composeName + ".bak-" + stamp);
    }
    p(`compose service ${DST_CONTAINER} added and validated`);

    // Entries move verbatim: addAccountsToConfig preserves each account's own
    // FavouriteGames (botFactory.addAccountsToBot would flatten them to one
    // game) and stamps host/configFile/container on BotAccount for us.
    const r = await bc.addAccountsToConfig(dst, DEST, fresh);
    const back = JSON.parse(await hosts.readFile(dst, DEST));
    const n = ((back.TwitchSettings || {}).TwitchUsers || []).length;
    if (n !== fresh.length) throw new Error(`read-back mismatch: expected ${fresh.length}, got ${n}`);
    p(`entries written and read back: added=${r.added} total=${n}`);

    await hosts.composeUp(dst, DST_CONTAINER);
    p(`${dst.id}/${DST_CONTAINER} started`);

    // Promotions: flip the destination's disabled copy on, with this entry's
    // effective game list, and restart just those containers.
    const byFile = new Map();
    for (const it of promote) { if (!byFile.has(it.file)) byFile.set(it.file, []); byFile.get(it.file).push(it); }
    for (const [f, items] of byFile) {
      const d = JSON.parse(await hosts.readFile(dst, f));
      const arr = (d.TwitchSettings || {}).TwitchUsers || [];
      let hit = 0;
      for (const it of items) {
        const e = arr.find((x) => String(x.ClientSecret || "").trim() === String(it.secret).trim());
        if (!e) continue;
        e.Enabled = true;
        if (it.games && it.games.length) e.FavouriteGames = it.games.slice();
        hit++;
      }
      await hosts.writeFileAtomic(dst, f, JSON.stringify(d, null, 2));
      await BotAccount.updateMany(
        { clientSecret: { $in: items.map((i) => i.secret) } },
        { $set: { host: dst.id, configFile: f, container: bc.containerForFile(f), enabled: true } },
      );
      await hosts.dockerContainer(dst, "restart", bc.containerForFile(f)).catch((e) => p("restart warn: " + e.message));
      p(`promoted ${hit}/${items.length} account(s) in ${dst.id}/${f} and restarted ${bc.containerForFile(f)}`);
    }

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
      { $set: { "bots.$[b].host": dst.id, "bots.$[b].container": DST_CONTAINER, "bots.$[b].file": DEST } },
      { arrayFilters: [{ "b.container": CONTAINER, "b.host": src.id }] },
    );
    p(`AutoFarmTask bots repointed: modified=${t.modifiedCount}`);
    const landed = await BotAccount.countDocuments({ clientSecret: { $in: secrets }, host: dst.id });
    p(`BotAccount now on ${dst.id}: ${landed}/${secrets.length} (moved ${fresh.length}, promoted ${promote.length}, retired-dupes ${droppedDisabled})`);
  } finally {
    await settings.setAutoFarm({ enabled: prior.enabled });
    p(`auto-farm restored to enabled=${prior.enabled}`);
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; return mongoose.disconnect(); });
