// Replay the farm lane engine's economics against the decisions the LEGACY
// engine actually recorded, and report whether they reproduce.
//
// This is the evidence the shadow comparison cannot produce. Once the legacy
// engine acts on a campaign it never re-decides it, so a shadow lane is
// compared against a decision made hours or days earlier under conditions that
// no longer exist — on prod that left 0 comparable pairs out of 300. Replay
// reconstructs the inputs of the moment the legacy engine decided and asks
// whether the same economics reach the same answer, which turns months of
// recorded history into evidence that is available immediately.
//
// READ-ONLY. Reads AutoFarmTask, MarketResearchSnapshot and SaleSignal; writes
// nothing, contacts no host and no marketplace. Safe against production.
//
//   node scripts/farm2-replay.js                          # every game, 110 days
//   node scripts/farm2-replay.js --game "Albion Online"   # one lane
//   node scripts/farm2-replay.js --days 30 --limit 200
//   node scripts/farm2-replay.js --json                   # machine-readable
//   node scripts/farm2-replay.js --verbose                # list every row
//
// See docs/FARM2-VERIFICATION.md for what the numbers do and do not prove.
require("dotenv").config();
const mongoose = require("mongoose");
const replay = require("../utils/farm2/replay");

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const GAME = arg("game", null);
const DAYS = Number(arg("days", replay.DEFAULT_MAX_AGE_DAYS)) || replay.DEFAULT_MAX_AGE_DAYS;
const LIMIT = Number(arg("limit", 500)) || 500;
const JSON_OUT = process.argv.includes("--json");
const VERBOSE = process.argv.includes("--verbose");

function pct(n, d) {
  if (!d) return "n/a";
  return Math.round((n / d) * 100) + "%";
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — this script reads the live decision history.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const report = await replay.replayHistory({
    game: typeof GAME === "string" ? GAME : null,
    maxAgeDays: DAYS,
    limit: LIMIT,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    return;
  }

  const scope = GAME ? `game "${GAME}"` : "all games";
  console.log(`\nFarm2 replay — ${scope}, decisions from the last ${DAYS} days\n`);
  console.log(`  examined      ${report.examined}`);
  console.log(`  scored        ${report.scored}   (full-fidelity reconstructions — the only evidence)`);
  console.log(`    agree       ${report.agree}   ${pct(report.agree, report.scored)}`);
  console.log(`    disagree    ${report.disagree}`);
  console.log(`  not scored:`);
  console.log(`    partial     ${report.partialFidelity}   (an input was assumed rather than known)`);
  console.log(`    inconclusive ${report.inconclusive}  (probably OUR gap, not an engine difference)`);
  console.log(`    unreplayable ${report.unreplayable}`);
  if (report.errors) console.log(`    errors      ${report.errors}`);

  if (Object.keys(report.gapCounts).length) {
    console.log(`\n  why rows could not be scored:`);
    for (const [gap, n] of Object.entries(report.gapCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${gap}`);
    }
  }

  const games = Object.entries(report.perGame).sort((a, b) => b[1].total - a[1].total);
  if (games.length > 1) {
    console.log(`\n  per game:`);
    console.log(`    ${"game".padEnd(28)} examined  scored  agree  disagree`);
    for (const [game, s] of games) {
      console.log(
        `    ${game.slice(0, 28).padEnd(28)} ${String(s.total).padStart(8)}  ${String(s.scored).padStart(6)}  ${String(s.agree).padStart(5)}  ${String(s.disagree).padStart(8)}`,
      );
    }
  }

  if (report.disagreements.length) {
    console.log(`\n  DISAGREEMENTS (${report.disagreements.length}) — each one is a lane bug or a legacy bug:`);
    for (const d of report.disagreements.slice(0, 40)) {
      const when = d.decidedAt ? new Date(d.decidedAt).toISOString().slice(0, 16) : "?";
      console.log(`    ${when}  ${String(d.game).slice(0, 24).padEnd(24)} legacy=${String(d.legacyDecision).padEnd(20)} ${d.detail}`);
    }
    if (report.disagreements.length > 40) {
      console.log(`    ... and ${report.disagreements.length - 40} more (use --json)`);
    }
  }

  if (VERBOSE) {
    console.log(`\n  every row:`);
    for (const r of report.rows) {
      const when = r.decidedAt ? new Date(r.decidedAt).toISOString().slice(0, 16) : "?";
      console.log(
        `    ${when}  ${String(r.game).slice(0, 22).padEnd(22)} ${String(r.legacyDecision).padEnd(20)} ${String(r.verdict).padEnd(13)} ${String(r.fidelity || "").padEnd(12)} ${r.detail || (r.notes || []).join("; ")}`,
      );
    }
  }

  console.log(
    `\n  Settings assumed: ${JSON.stringify(report.afAssumed)}` +
      `\n  utils/settings.js is not versioned, so these are TODAY's values applied to` +
      `\n  past decisions. If any of them changed during the window, rows either side` +
      `\n  of the change are being replayed under the wrong configuration.\n`,
  );

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
