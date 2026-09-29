// "Does this bot have anything left to farm?" — answered by TwitchDropsBot
// itself. Every enabled account runs a 5-minute cycle; when it has no campaign
// it can still earn it ends the cycle with "No broadcaster or campaign left".
// The server's own verdicts (scan data, campaign manifests, DropLog matching)
// can miss what the bot knows directly — subscription-only drops, campaigns
// that need a linked game account, item names that don't line up — which left
// finished bots running for days.
//
// The classifier runs ON the bot host (python3, fed `docker logs --tail N`), so
// only one short line per container crosses the link.
const hosts = require("./botHosts");

// A verdict is only trusted after the container has been up long enough for
// every account to run a full cycle since it started.
const FINISH_MIN_UPTIME_S =
  Number(process.env.BOT_FINISH_MIN_UPTIME_S) || 12 * 60;
const LOG_TAIL = 3000;

// argv: <config.json path> <container StartedAt>; stdin = the container's log.
// Prints "<enabled>|<finished>|<pending>|<unknown>" over the config's ENABLED
// logins. Per account, only lines since the container started count, and only
// its last COMPLETE cycle (between its last two "Waiting 300 seconds" lines):
//   finished = that cycle ended in "No broadcaster or campaign left" and no
//              broadcast-wait / watching line appeared since the cycle began.
//   pending  = a broadcast-wait or watching line since the cycle began.
//   unknown  = anything else (no full cycle yet, errors, never logged).
const LOG_VERDICT_PY = [
  "import sys, json, re",
  "cfg, started = sys.argv[1], sys.argv[2]",
  "try:",
  "    d = json.load(open(cfg))",
  "    users = (d.get('TwitchSettings') or {}).get('TwitchUsers') or []",
  "    enabled = set(str(u.get('Login') or '').strip().lower() for u in users",
  "                  if isinstance(u, dict) and u.get('Enabled', True) is not False)",
  "    enabled.discard('')",
  "except Exception:",
  "    print('ERR|config'); sys.exit(0)",
  "since = started.replace('T', ' ')[:19]",
  "acct = re.compile(r'\\[TwitchUser - ([A-Za-z0-9_]+)\\]')",
  "prev, last, none_left, pend = {}, {}, {}, {}",
  "for i, line in enumerate(sys.stdin):",
  "    if line[:19] < since:",
  "        continue",
  "    m = acct.search(line)",
  "    if not m:",
  "        continue",
  "    a = m.group(1).lower()",
  "    if 'Waiting 300 seconds' in line:",
  "        prev[a] = last.get(a, -1)",
  "        last[a] = i",
  "    if 'No broadcaster or campaign left' in line:",
  "        none_left[a] = i",
  "    if ('No live broadcaster found' in line or 'No broadcaster found for this campaign' in line",
  "            or 'minutes watched' in line or 'Watching ' in line):",
  "        pend[a] = i",
  "f = p = u = 0",
  "for a in enabled:",
  "    start = prev.get(a, -1)",
  "    if start >= 0 and pend.get(a, -1) > start:",
  "        p += 1",
  "    elif start >= 0 and start < none_left.get(a, -1) < last.get(a, -1):",
  "        f += 1",
  "    else:",
  "        u += 1",
  "print('%d|%d|%d|%d' % (len(enabled), f, p, u))",
].join("\n");

// One host round trip for many containers. entries: [{ container, configPath }]
// (configPath absolute on that host). Returns { [container]: verdict|null }.
async function hostLogVerdicts(host, entries) {
  const list = (entries || []).filter((e) => e && /^[A-Za-z0-9_.-]+$/.test(e.container));
  if (!list.length) return {};
  const parts = list.map(
    (e) =>
      "c=" + hosts.shq(e.container) + "; " +
      "st=$(docker inspect -f '{{.State.StartedAt}}' \"$c\" 2>/dev/null); " +
      "up=$(( $(date +%s) - $(date -d \"$st\" +%s 2>/dev/null || date +%s) )); " +
      "v=$(docker logs --tail " + LOG_TAIL + " \"$c\" 2>&1 | python3 -c " + hosts.shq(LOG_VERDICT_PY) +
      " " + hosts.shq(e.configPath) + " \"$st\" 2>/dev/null); " +
      "[ -n \"$v\" ] || v=\"ERR|py\"; echo \"LOGV|$c|$up|$v\"",
  );
  const { stdout } = await hosts.runShell(host, parts.join("; "), { timeout: 120000 });
  return parseLogVerdicts(stdout);
}

function parseLogVerdicts(stdout) {
  const out = {};
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("LOGV|")) continue;
    const [, container, up, enabled, finished, pending, unknown] = line.split("|");
    if (!container) continue;
    out[container] =
      enabled === "ERR"
        ? null
        : {
            uptimeS: Number(up) || 0,
            enabled: Number(enabled) || 0,
            finished: Number(finished) || 0,
            pending: Number(pending) || 0,
            unknown: Number(unknown) || 0,
          };
  }
  return out;
}

// Every enabled account showed a clean "nothing left" cycle since this
// container started, and it has been up long enough for that to mean something.
function isNothingLeft(v) {
  return !!(
    v &&
    v.uptimeS >= FINISH_MIN_UPTIME_S &&
    v.enabled > 0 &&
    v.finished === v.enabled &&
    v.pending === 0 &&
    v.unknown === 0
  );
}

module.exports = {
  FINISH_MIN_UPTIME_S,
  LOG_TAIL,
  LOG_VERDICT_PY,
  hostLogVerdicts,
  parseLogVerdicts,
  isNothingLeft,
};
