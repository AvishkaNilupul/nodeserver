// ---------------------------------------------------------------------------
// Pure copy templater for the No-claim Farming "social post generator". Given a
// game and its already-filtered unclaimed drops, it produces ready-to-paste
// post copy (title + item list + a fixed escrow line + per-game hashtags) for
// the operator to copy into X / Reddit / etc. BY HAND. Generation ONLY —
// nothing here (or anywhere in this feature) posts anything itself.
//
// Kept deliberately pure and dependency-free (no I/O, network, DB or Pi) so it
// is fully unit-testable in isolation; the route layer does the fetching and
// hands this plain { game, items } data.
// ---------------------------------------------------------------------------

// The one line every post carries verbatim — escrow is the trust anchor of the
// sale, so it is fixed rather than templated per game.
const ESCROW_LINE = "Delivered safely via escrow (Gameflip). DM for price 👇";

// Per-game templates keyed by a normalised game id. Each game gets a headline
// and its own 2–3 hashtags (the tags buyers actually search that game's drops
// under), with a generic fallback for anything not explicitly handled.
const TEMPLATES = {
  r6: {
    title: "🎮 Rainbow Six Siege Twitch Drops — unclaimed & ready",
    hashtags: ["#R6Siege", "#RainbowSixSiege", "#TwitchDrops"],
  },
  ow: {
    title: "🎮 Overwatch 2 Twitch Drops — unclaimed & ready",
    hashtags: ["#Overwatch2", "#OverwatchTrading", "#TwitchDrops"],
  },
  rl: {
    title: "🎮 Rocket League Twitch Drops — unclaimed & ready",
    hashtags: ["#RocketLeague", "#RLtrading", "#TwitchDrops"],
  },
  generic: {
    title: "🎮 Twitch Drops — unclaimed & ready",
    hashtags: ["#TwitchDrops", "#GameDrops"],
  },
};

// Fold the many ways a game arrives onto one template key: Twitch's displayName
// ("Overwatch 2"), the no-claim game keyword the operator typed ("rainbow six"),
// or a short alias ("R6"/"OW2"/"RL"). Substring match first, then the bare
// aliases as whole words so "rl" can't match inside an unrelated word.
function normGame(game) {
  const g = String(game || "")
    .trim()
    .toLowerCase();
  if (!g) return "generic";
  if (g.includes("rainbow six") || g.includes("rainbowsix") || /\br6\b/.test(g))
    return "r6";
  if (g.includes("overwatch") || /\bow2?\b/.test(g)) return "ow";
  if (g.includes("rocket league") || /\brl\b/.test(g)) return "rl";
  return "generic";
}

// Positive integer copy count for display/sort; anything odd collapses to 1.
function qtyOf(item) {
  const n = Math.floor(Number(item && item.count));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Build the post copy for one account's unclaimed drops.
//   { game, items:[{ name, count }] } -> { title, body, hashtags, text }
// `items` is already filtered to the sellable (buyer-must-connect) drops by the
// caller. Highest-count items lead the list — a stacked pack (e.g. "10× Loot
// Box") is the selling point, so it should read first.
function buildSocialPost({ game, items } = {}) {
  const tpl = TEMPLATES[normGame(game)];
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({
      name: String((it && it.name) || "").trim(),
      qty: qtyOf(it),
    }))
    .filter((it) => it.name)
    .sort((a, b) => b.qty - a.qty); // count-desc; stable for ties on V8

  const lines = list.map(
    (it) => "• " + (it.qty > 1 ? it.qty + "× " : "") + it.name,
  );
  const body = lines.join("\n");

  // One blank line between blocks; the item block is dropped entirely when the
  // account has no sellable drops so an empty post still reads cleanly.
  const parts = [tpl.title];
  if (body) parts.push(body);
  parts.push(ESCROW_LINE);
  parts.push(tpl.hashtags.join(" "));

  return {
    title: tpl.title,
    body,
    hashtags: tpl.hashtags.slice(), // copy — callers must not mutate the template
    text: parts.join("\n\n"),
  };
}

module.exports = { buildSocialPost };
