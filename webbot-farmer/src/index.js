#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { makeSession, validate, WEB_CLIENT_ID, getInventory } from "./twitch.js";
import { watchChannel } from "./watcher.js";
import { pickGame, pickChannelForGame } from "./autoPicker.js";

function parseArgs(argv) {
  const out = {
    token: null,
    channel: null,
    game: null,
    maxMinutes: 0,
    probeOnly: false,
    verbose: false,
    auto: false,
    manage: false,
    mongoUri: null,
    importFile: null,
    priorityGames: null,
    maxConcurrent: 0,
    metrics: false,
    botConfig: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") out.token = argv[++i];
    else if (a === "--channel") out.channel = argv[++i];
    else if (a === "--game") out.game = argv[++i];
    else if (a === "--max-minutes") out.maxMinutes = Number(argv[++i]) || 0;
    else if (a === "--probe") out.probeOnly = true;
    else if (a === "--auto") out.auto = true;
    else if (a === "--manage") out.manage = true;
    else if (a === "--mongo") out.mongoUri = argv[++i];
    else if (a === "--import-file") out.importFile = argv[++i];
    else if (a === "--priority-games") out.priorityGames = argv[++i];
    else if (a === "--max-concurrent") out.maxConcurrent = Number(argv[++i]) || 0;
    else if (a === "--metrics") out.metrics = true;
    else if (a === "--bot-config") out.botConfig = argv[++i];
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (!out.token) out.token = process.env.TWITCH_TOKEN || null;
  if (!out.channel) out.channel = process.env.TWITCH_CHANNEL || null;
  if (!out.mongoUri) out.mongoUri = process.env.MONGO_URI || null;
  return out;
}

function help() {
  console.log(`webbot-drops — headless Twitch drop farmer using web OAuth tokens

Single-account modes:
  --token T --probe                       validate + dump inventory
  --token T --channel LOGIN               farm a specific live channel
  --token T --auto [--game NAME]          auto-pick game (from Inventory or --game)
                                          and auto-pick a live drops-tagged channel
    --max-minutes N                       stop after N minutes (0 = forever)
    --verbose                             log spade responses + raw progress

Multi-account manager (needs Mongo):
  --manage --mongo URI                    read WebBotAccount rows, farm all
    --priority-games "Rust,Overwatch"     used when an account has nothing in progress
                                          (or set env WEBBOT_PRIORITY_GAMES)
    --max-concurrent N                    max accounts farming at once (default 25;
                                          or set env WEBBOT_MAX_CONCURRENT). Set >=
                                          account count to farm everyone at once.
    --metrics                             log request-rate/RAM/endpoint metrics
                                          every 60s (or set env WEBBOT_METRICS=1)
  --import-file PATH --mongo URI          seed WebBotAccount from a text file of
                                          user:pass:token or user:token or token lines
`);
}

async function runProbe(session) {
  const inv = await getInventory(session);
  const rows = inv?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];
  if (!rows.length) return console.log("inventory: no drops in progress");
  for (const c of rows) {
    console.log(`• ${c.game?.displayName || "?"} — ${c.name} (${c.status})`);
    for (const d of c.timeBasedDrops || []) {
      const s = d.self || {};
      console.log(
        `    · ${d.name}: ${s.currentMinutesWatched ?? 0}/${d.requiredMinutesWatched} min` +
          (s.isClaimed ? " ✓claimed" : s.dropInstanceID ? " (ready)" : ""),
      );
    }
  }
}

async function runAuto(session, args) {
  const priority = args.game ? [args.game] : [];
  const target = await pickGame(session, priority);
  if (!target) {
    console.error("nothing to farm — no in-progress drops and no --game hint");
    process.exit(2);
  }
  console.log(`picked game: ${target.game} (source: ${target.source})`);
  const channel = await pickChannelForGame(session, target.game);
  if (!channel) {
    console.error(`no live channel for ${target.game}`);
    process.exit(3);
  }
  console.log(
    `picked channel: ${channel.login} (${channel.viewers} viewers, drops-tag=${channel.hasDropTag})`,
  );
  await watchChannel(session, channel.login, {
    maxMinutes: args.maxMinutes,
    verbose: args.verbose,
  });
}

async function runManage(args) {
  const { runManager } = await import("./manager.js");
  const priority =
    args.priorityGames
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) || undefined;
  await runManager({
    mongoUri: args.mongoUri,
    priorityGames: priority,
    maxConcurrent: args.maxConcurrent,
    metrics: args.metrics,
  });
}

// Single-bot mode: farm a fixed set of accounts on one game, read from a JSON
// config file. No Mongo — this is what runs inside each per-bot Docker
// container on the Pi (like the no-claim rig). Config shape:
//   { "game": "Rust", "maxConcurrent": 50,
//     "accounts": [ { "login": "foo", "webToken": "..." }, ... ] }
async function runBotConfig(args) {
  const raw = await readFile(args.botConfig, "utf8");
  const cfg = JSON.parse(raw);
  const game = String(cfg.game || "").trim();
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const rows = accounts
    .filter((a) => a && a.webToken)
    .map((a) => ({
      webToken: a.webToken,
      login: a.login || "",
      pinnedGame: game, // every account in a bot farms the bot's game
      claimBlocked: false,
      totalMinutesWatched: 0,
    }));
  if (!rows.length) {
    console.error("bot-config: no accounts with a webToken in the config");
    process.exit(2);
  }
  const { farmAccounts } = await import("./manager.js");
  const stopSignal = { stopped: false };
  const stop = () => {
    stopSignal.stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`bot-config: farming ${rows.length} account(s) on "${game || "(auto)"}"`);
  await farmAccounts({
    rows,
    priorityGames: game ? [game] : [],
    maxConcurrent: cfg.maxConcurrent || rows.length,
    stopSignal,
  });
}

async function runImport(args) {
  const { connect: mongoConnect, importAccountsFromLines, disconnect } =
    await import("./mongoStore.js");
  await mongoConnect(args.mongoUri);
  const text = await readFile(args.importFile, "utf8");
  const lines = text.split(/\r?\n/);
  const result = await importAccountsFromLines(lines);
  console.log(
    `imported ${result.created.length}, updated-in-place ${result.updated.length}, skipped ${result.skipped.length}`,
  );
  if (result.skipped.length)
    for (const s of result.skipped) console.log(`  · skipped: ${s.reason} — ${s.line.slice(0, 60)}`);
  await disconnect();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return help();

  if (args.botConfig) return runBotConfig(args);

  if (args.importFile) {
    if (!args.mongoUri) {
      console.error("--import-file requires --mongo URI (or MONGO_URI env)");
      process.exit(1);
    }
    return runImport(args);
  }

  if (args.manage) {
    if (!args.mongoUri) {
      console.error("--manage requires --mongo URI (or MONGO_URI env)");
      process.exit(1);
    }
    return runManage(args);
  }

  // Single-account paths need a token
  if (!args.token) {
    help();
    process.exit(1);
  }

  const session = makeSession({ token: args.token, clientId: WEB_CLIENT_ID });
  let who;
  try {
    who = await validate(session);
  } catch (e) {
    console.error("token validation failed:", e.message);
    process.exit(2);
  }
  console.log(
    `authed as ${who.login} (user_id=${who.user_id}, client_id=${who.client_id}, ` +
      `expires_in=${who.expires_in}s)`,
  );

  if (args.probeOnly) return runProbe(session);
  if (args.auto) return runAuto(session, args);

  if (!args.channel) {
    console.error("give one of: --channel <login>, --auto, --probe, --manage");
    process.exit(1);
  }
  await watchChannel(session, args.channel, {
    maxMinutes: args.maxMinutes,
    verbose: args.verbose,
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
