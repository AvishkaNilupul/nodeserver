#!/usr/bin/env node
// Reconcile BotAccount rows that point at a host against what that fleet is
// ACTUALLY running, and retire the pointers that no longer correspond to a
// live config.
//
// WHY THIS EXISTS
// BotAccount.host/configFile/container is the record of where an account lives.
// A cross-host migration (see scripts/move-bot-host.js) repoints the configs it
// moves, but anything retired OUT of band leaves its row behind: after the
// no-claim farm moved pi -> contabo (2026-09-14/15) 306 unsold rows still named
// the Pi, 194 of them enabled, pointing at noclaim-bot-* containers that no
// longer exist there. Nothing farms off those rows, but every per-host report
// counts them, and an orphan-release / pool-reclaim pass trusts BotAccount.host
// as its fallback record of what lives on an offline host
// (utils/accountPoolChecker, and the hard rule in the pi-link notes) — so a
// lying ledger is exactly the input that produced duplicate sprawl before.
//
// USAGE (run on the prod server, from the app root):
//   node scripts/reconcile-host-ledger.js --host pi
//   ... add --apply to write. Without it, nothing is written.
//   ... --json <path> dumps the full per-row classification for auditing.
//
// WHAT IT WRITES (only ever these three fields)
//   * live somewhere  -> repoint host/configFile/container (+ enabled, to match
//                        the config entry). Real drift, worth correcting.
//   * live nowhere    -> container:"", configFile:"", enabled:false.
// Rows are never deleted, and soldAt / suspendedAt / pool state are never
// touched: a retired pointer is not a retired account.
//
// SAFETY
//   * Reads EVERY config on EVERY managed host plus the no-claim fleet, and
//     ABORTS if any of them is unreadable. A host that cannot be read makes its
//     accounts look orphaned, and disabling a live account is the one mistake
//     that costs real money.
//   * soldAt:{$ne:null} rows are out of scope — a sold account's pointer is
//     delivery history.
//   * Dry-run by default; the write is a separate explicit step.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const APP = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(APP, ".env") });
const mongoose = require("mongoose");
const hosts = require(path.join(APP, "utils", "botHosts"));
const fleet = require(path.join(APP, "utils", "noclaimFleet"));
const BotAccount = require(path.join(APP, "models", "BotAccount"));
const UnclaimedAccount = require(path.join(APP, "models", "UnclaimedAccount"));

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const APPLY = process.argv.includes("--apply");
const LEDGER_HOST = arg("host", "pi");
const JSON_OUT = arg("json", "");
const CFG_RE = /^config(_\d{1,3})?\.json$/;
const p = (...a) => console.log("  ", ...a);
const secretOf = (v) => String(v || "").trim();

// Mirrors routes/botConfigRoutes.containerForFile without dragging the whole
// express router (and its module-level state) into a read-only audit.
function containerForFile(file) {
  const m = String(file).match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  if (file === "config.json") return "twitchbot";
  return null;
}

// --- Live-config index ------------------------------------------------------

// Every managed host's configs, in one readFiles round trip per host. Throws on
// the first unreadable host/file: an incomplete index cannot be told apart from
// a genuinely empty fleet, and the difference is whether we disable live rows.
async function indexManagedHosts() {
  const index = new Map();
  const seen = [];
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    let files;
    try {
      files = (await hosts.readdir(host)).filter((f) => CFG_RE.test(f));
    } catch (e) {
      throw new Error(`cannot list configs on host "${h.id}" (${e.message}) — refusing to judge any row orphaned`);
    }
    const raw = files.length ? await hosts.readFiles(host, files) : {};
    let entries = 0;
    for (const f of files) {
      const e = raw[f];
      if (!e || !e.ok) throw new Error(`cannot read ${h.id}/${f} (${(e && e.error) || "no result"}) — refusing to judge any row orphaned`);
      let d;
      try { d = JSON.parse(e.text); } catch (err) {
        throw new Error(`${h.id}/${f} is not valid JSON (${err.message}) — refusing to judge any row orphaned`);
      }
      for (const u of ((d.TwitchSettings || {}).TwitchUsers) || []) {
        const k = secretOf(u.ClientSecret);
        if (!k) continue;
        entries++;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push({
          kind: "managed",
          host: h.id,
          file: f,
          container: containerForFile(f) || "",
          enabled: u.Enabled !== false,
          login: u.Login || "",
        });
      }
    }
    seen.push(`${h.id}: ${files.length} configs, ${entries} entries`);
  }
  return { index, seen };
}

// The no-claim fleet is NOT a botHosts config dir — its bots live under
// noclaimFleet.BOTS_DIR on fleet.HOST_ID — but its configs are live configs,
// and the rows we are auditing name its containers. Read them the way the
// engine does (fleet.sh + the real BOTS_DIR), never a hand-typed host+path.
async function indexNoClaimFleet(index) {
  const marker = "@@@NCFG ";
  const script =
    `for d in ${hosts.shq(fleet.BOTS_DIR)}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
    `printf '\\n${marker}%s\\n' "$d"; cat "$d"; done | gzip -c | base64 | tr -d '\\n'`;
  const b64 = await fleet.sh(script, { timeout: 120000 });
  let text;
  try {
    text = zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  } catch (e) {
    throw new Error(`cannot read the no-claim fleet configs (${e.message}) — refusing to judge any row orphaned`);
  }
  const parts = text.split(new RegExp("\\n" + marker + "(.+)\\n"));
  const bots = [];
  for (let i = 1; i < parts.length; i += 2) {
    const file = parts[i];
    const m = file.match(/\/bots\/([^/]+)\/Configuration\/config\.json$/);
    const id = m ? m[1] : file;
    let d;
    try { d = JSON.parse(parts[i + 1]); } catch (err) {
      throw new Error(`no-claim ${file} is not valid JSON (${err.message}) — refusing to judge any row orphaned`);
    }
    const users = ((d.TwitchSettings || {}).TwitchUsers) || [];
    bots.push({ id, n: users.length });
    for (const u of users) {
      const k = secretOf(u.ClientSecret);
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({
        kind: "noclaim",
        host: fleet.HOST_ID,
        file: "",
        container: fleet.containerFor(id),
        enabled: u.Enabled !== false,
        login: u.Login || "",
      });
    }
  }
  if (!bots.length) throw new Error("no-claim fleet returned zero configs — refusing to judge any row orphaned");
  return bots;
}

// Pick the entry that decides where an account really lives: an enabled copy
// beats a disabled one (a disabled entry is retirement residue — 237 such
// duplicates exist across this fleet). Two ENABLED copies is a dupeGuard-class
// problem, not a bookkeeping one, so those rows are reported and left alone.
function chooseHome(hits) {
  const on = hits.filter((h) => h.enabled);
  if (on.length > 1) return { conflict: true, hits: on };
  if (on.length === 1) return { conflict: false, home: on[0] };
  return { conflict: false, home: hits[0] };
}

// Container state per host, so the report can say whether the config a row
// points at is actually RUNNING. "exists" is not enough: `docker ps -a` lists
// containers that were stopped weeks ago, and a config whose container is
// exited still holds the account (it farms again the moment it starts), which
// is why presence in a config — not container state — decides live vs orphan.
async function indexContainerStates() {
  const byHost = new Map();
  for (const h of hosts.listHosts()) {
    try {
      byHost.set(h.id, await hosts.dockerPs(hosts.resolveHost(h.id)));
    } catch (e) {
      p(`warn: docker ps on ${h.id} failed (${e.message}) — its container states show as "unknown"`);
      byHost.set(h.id, null);
    }
  }
  return (hostId, container) => {
    if (!container) return "-";
    const ps = byHost.get(hostId);
    if (ps === undefined) return "unknown-host";
    if (ps === null) return "unknown";
    const c = ps[container];
    return c ? c.state : "absent";
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`== reconcile BotAccount rows on host "${LEDGER_HOST}"   APPLY=${APPLY}`);

  const { index, seen } = await indexManagedHosts();
  for (const s of seen) p("managed " + s);
  const ncBots = await indexNoClaimFleet(index);
  p(`no-claim fleet (${fleet.HOST_ID}): ${ncBots.length} bots, ${ncBots.reduce((a, b) => a + b.n, 0)} entries`);
  p(`live index: ${index.size} distinct ClientSecrets across every host`);

  const rows = await BotAccount.find({ host: LEDGER_HOST, soldAt: null })
    .select("clientSecret login twitchId host configFile container enabled dropCount lastScanStatus suspendedAt")
    .lean();
  p(`ledger: ${rows.length} rows with host="${LEDGER_HOST}" soldAt:null (${rows.filter((r) => r.enabled).length} enabled)`);

  const stateOf = await indexContainerStates();

  // Cross-reference the no-claim ledger, which is where these accounts are
  // actually tracked. Matched on login (UnclaimedAccount is keyed by login /
  // poolAccountId, it carries no ClientSecret).
  const logins = [...new Set(rows.map((r) => String(r.login || "").toLowerCase()).filter(Boolean))];
  const ua = logins.length
    ? await UnclaimedAccount.find({ loginLower: { $in: logins } }).select("loginLower status botId container soldAt").lean()
    : [];
  const uaBy = new Map(ua.map((u) => [u.loginLower, u]));

  const cat = { repoint: [], okAlready: [], retire: [], alreadyRetired: [], conflict: [] };
  for (const r of rows) {
    const hits = index.get(secretOf(r.clientSecret)) || [];
    const u = uaBy.get(String(r.login || "").toLowerCase()) || null;
    const item = {
      _id: String(r._id), login: r.login, secret: r.clientSecret,
      from: { host: r.host, configFile: r.configFile, container: r.container, enabled: !!r.enabled },
      dropCount: r.dropCount, lastScanStatus: r.lastScanStatus, suspended: !!r.suspendedAt,
      unclaimed: u ? { status: u.status, botId: u.botId, container: u.container, sold: !!u.soldAt } : null,
      fromState: stateOf(r.host, r.container),
    };
    if (!hits.length) {
      const clean = !r.container && !r.configFile && r.enabled === false;
      item.to = { container: "", configFile: "", enabled: false };
      (clean ? cat.alreadyRetired : cat.retire).push(item);
      continue;
    }
    const pick = chooseHome(hits);
    if (pick.conflict) { item.hits = pick.hits; cat.conflict.push(item); continue; }
    const h = pick.home;
    item.to = { host: h.host, configFile: h.file, container: h.container, enabled: h.enabled };
    item.via = h.kind;
    item.toState = stateOf(h.host, h.container);
    const samePointer = r.host === h.host && (r.configFile || "") === h.file &&
      (r.container || "") === h.container;
    const sameFlag = !!r.enabled === h.enabled;
    item.pointerMoves = !samePointer;
    if (samePointer && sameFlag) cat.okAlready.push(item);
    else cat.repoint.push(item);
  }

  const tally = (list, key) => {
    const m = new Map();
    for (const it of list) { const k = key(it); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log("\n== CLASSIFICATION (read-only) ==");
  const moved = cat.repoint.filter((i) => i.pointerMoves);
  const flagOnly = cat.repoint.filter((i) => !i.pointerMoves);
  p(`LIVE, pointer is wrong  : ${moved.length}`);
  for (const [k, n] of tally(moved, (i) => `${i.from.host}/${i.from.container || "(none)"} [${i.fromState}] -> ${i.to.host}/${i.to.container || i.to.configFile || "(none)"} [${i.via}, ${i.toState}]  enabled ${i.from.enabled}->${i.to.enabled}`)) p(`     ${String(n).padStart(4)}  ${k}`);
  p(`LIVE, only enabled wrong: ${flagOnly.length}`);
  for (const [k, n] of tally(flagOnly, (i) => `${i.to.host}/${i.to.container} [${i.toState}]  enabled ${i.from.enabled}->${i.to.enabled}`)) p(`     ${String(n).padStart(4)}  ${k}`);
  p(`LIVE, already correct   : ${cat.okAlready.length}`);
  p(`ENABLED ON >1 HOST      : ${cat.conflict.length}  ${cat.conflict.length ? "<-- dupeGuard problem, NOT touched" : ""}`);
  for (const [k, n] of tally(cat.conflict, (i) => i.hits.map((h) => `${h.host}/${h.container || h.file} [${h.kind}, ${stateOf(h.host, h.container)}]`).join("  +  "))) p(`     ${String(n).padStart(4)}  ${k}`);
  p(`ORPHAN, needs retiring  : ${cat.retire.length}`);
  for (const [k, n] of tally(cat.retire, (i) => `container=${JSON.stringify(i.from.container)} [${i.fromState} on ${i.from.host}] configFile=${JSON.stringify(i.from.configFile)} enabled=${i.from.enabled}`)) p(`     ${String(n).padStart(4)}  ${k}`);
  p(`ORPHAN, already clean   : ${cat.alreadyRetired.length}  (no write needed)`);
  const ucSplit = tally(cat.retire.concat(cat.alreadyRetired), (i) => i.unclaimed ? `UnclaimedAccount status=${i.unclaimed.status}${i.unclaimed.sold ? " sold" : ""}` : "no UnclaimedAccount row");
  p("orphans cross-referenced against UnclaimedAccount:");
  for (const [k, n] of ucSplit) p(`     ${String(n).padStart(4)}  ${k}`);
  const total = cat.repoint.length + cat.okAlready.length + cat.conflict.length + cat.retire.length + cat.alreadyRetired.length;
  if (total !== rows.length) throw new Error(`conservation check failed: ${total} classified vs ${rows.length} rows`);
  p(`conservation ok: ${total} == ${rows.length}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(cat, null, 2));
    p(`full classification written to ${JSON_OUT}`);
  }

  if (!APPLY) {
    console.log("\n   DRY RUN — no changes made (pass --apply)");
    return;
  }

  console.log("\n== APPLYING ==");
  const ops = [];
  for (const it of cat.repoint) {
    ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(it._id) }, update: { $set: { host: it.to.host, configFile: it.to.configFile, container: it.to.container, enabled: it.to.enabled } } } });
  }
  for (const it of cat.retire) {
    ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(it._id) }, update: { $set: { container: "", configFile: "", enabled: false } } } });
  }
  if (!ops.length) return p("nothing to write");
  const res = await BotAccount.bulkWrite(ops, { ordered: false });
  p(`bulkWrite: matched=${res.matchedCount} modified=${res.modifiedCount} of ${ops.length} ops`);

  // Read back: the write is only believed if the rows now say what we intended.
  let bad = 0;
  const check = await BotAccount.find({ _id: { $in: [...cat.repoint, ...cat.retire].map((i) => new mongoose.Types.ObjectId(i._id)) } })
    .select("host configFile container enabled soldAt suspendedAt").lean();
  const want = new Map([...cat.repoint, ...cat.retire].map((i) => [i._id, i]));
  for (const r of check) {
    const w = want.get(String(r._id));
    const to = w.to;
    const okHost = to.host === undefined ? true : r.host === to.host;
    if (!okHost || (r.configFile || "") !== to.configFile || (r.container || "") !== to.container || !!r.enabled !== to.enabled || r.soldAt !== null) bad++;
  }
  p(`read-back: ${check.length} rows checked, ${bad} mismatched`);
  if (bad) throw new Error("read-back mismatch — inspect before doing anything else");
  const left = await BotAccount.countDocuments({ host: LEDGER_HOST, soldAt: null, enabled: true, container: { $ne: "" } });
  p(`host="${LEDGER_HOST}" soldAt:null enabled with a container left: ${left}`);
}

main()
  .then(() => mongoose.disconnect())
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; return mongoose.disconnect(); });
