#!/usr/bin/env node
// Apply the market radar's two hooks (docs/MARKET-RADAR-PLAN.md) to a checkout's own copies of
//   utils/priceScout.js      — ADDITIVE row fields (ids, dates, seller scores, counters) and an
//                              explicit `complete` flag on a Gameflip page read in full;
//   utils/marketResearch.js  — one guarded `require("./marketData").tap(...)` inside scanGame.
//
// Both files differ between checkouts (production carries the FunPay removal and the bulk-pack
// filter), so they are PATCHED in place, never replaced. Every anchor must match exactly once or
// the file is left untouched; a file that already has its hook is reported and skipped.
//
//   node scripts/apply-market-radar-hooks.js <priceScout.js> <marketResearch.js>          dry run
//   node scripts/apply-market-radar-hooks.js <priceScout.js> <marketResearch.js> --write  apply
const fs = require("fs");

const SCOUT_MARKER = "function numOrNull(";
const SCOUT_HUNKS = [
  {
    label: "numOrNull helper",
    old: `function round2(n) {
  return Math.round(n * 100) / 100;
}
`,
    new: `function round2(n) {
  return Math.round(n * 100) / 100;
}

// A number, or null when the field is absent/blank/not numeric (Number(null) is 0, which
// would turn "unknown" into a real zero).
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
`,
  },
  {
    label: "gameflip rows",
    old: `  const rows = (r.data && r.data.data) || [];
  return rows
    .filter((x) => x && x.name && Number(x.price) > 0)
    .map((x) => ({
      title: String(x.name),
      price: round2(Number(x.price) / 100),
      url: "https://gameflip.com/item/" + x.id,
      updated: x.updated || null,
      // Who is selling it. One seller listing the same bundle 20 times is one
      // competitor, not 20 — see competitionOf in utils/marketResearch.js.
      seller: String(x.owner || ""),
      sellerName: "",
      sold: undefined,
    }));
}`,
    new: `  const rows = (r.data && r.data.data) || [];
  const out = rows
    .filter((x) => x && x.name && Number(x.price) > 0)
    .map((x) => ({
      title: String(x.name),
      price: round2(Number(x.price) / 100),
      url: "https://gameflip.com/item/" + x.id,
      updated: x.updated || null,
      // Who is selling it. One seller listing the same bundle 20 times is one
      // competitor, not 20 — see competitionOf in utils/marketResearch.js.
      seller: String(x.owner || ""),
      sellerName: "",
      sold: undefined,
      // Extra fields for the market radar (utils/marketData). Additive: every existing
      // consumer reads title/price/url/seller/sold/updated and ignores the rest.
      id: String(x.id || ""),
      created: x.created || null,
      onsale: x.onsale || null,
      platform: x.platform ? String(x.platform) : "",
      sellerScore: numOrNull(x.seller_score),
      sellerRating: numOrNull(x.seller_rating_score),
      sellerRatings: numOrNull(x.seller_ratings),
    }));
  // Did this page hold EVERYTHING the search has? Only then can a rival that is missing from
  // it be counted as gone. Only a real result (an array of rows) under the page limit says so: a
  // failed fetch (callers turn it into []) never carries the flag, and neither does an error body
  // relayed through the Pi (curl without --fail), which parses as JSON with no \`data\` array.
  // Non-enumerable, so nothing that serialises the rows sees it.
  const real = !!(r && r.data && Array.isArray(r.data.data));
  Object.defineProperty(out, "complete", { value: real && rows.length < (limit || MAX_ROWS), enumerable: false });
  return out;
}`,
  },
  {
    label: "plati rows",
    old: `      seller: String(x.seller_id || ""),
      sellerName: String(x.seller_name || ""),
      sold: Number(x.numsold) || 0,
    }));
}`,
    new: `      seller: String(x.seller_id || ""),
      sellerName: String(x.seller_name || ""),
      sold: Number(x.numsold) || 0,
      // Extra fields for the market radar (additive). \`soldRaw\` is null when the page had no
      // counter (\`sold\` turns that into 0); \`priceRub\` is the price the seller set.
      id: String(x.id || ""),
      soldRaw: numOrNull(x.numsold),
      priceRub: numOrNull(x.price_rur),
      rating: numOrNull(x.seller_rating),
      soldHidden: numOrNull(x.numsold_hidden),
      positive: numOrNull(x.count_positiveresponses),
      negative: numOrNull(x.count_negativeresponses),
      returns: numOrNull(x.count_returns),
      ticks: numOrNull(x.TicksLastChange),
    }));
}`,
  },
  {
    label: "ggsel rows",
    old: `      seller: String(o.id_seller || ""),
      sellerName: String(o.seller_name || ""),
      sold: Number(o.cnt_sell) || 0,
    });`,
    new: `      seller: String(o.id_seller || ""),
      sellerName: String(o.seller_name || ""),
      sold: Number(o.cnt_sell) || 0,
      // Extra fields for the market radar (additive). \`id\` is the same id our own offers
      // carry as \`externalId\`, which is how our rows are told from rivals'.
      id: String(o.id_goods),
      soldRaw: numOrNull(o.cnt_sell),
      priceRub: numOrNull(o.price_wmr),
      rating: numOrNull(o.rating),
      autoselling: !!o.autoselling,
    });`,
  },
];

const TAP_MARKER = 'require("./marketData").tap(';
const TAP_HUNKS = [
  {
    label: "scanGame tap",
    old: `  const plRel = relevant(pl, game);
`,
    new: `  const plRel = relevant(pl, game);
  // Market radar (utils/marketData, docs/MARKET-RADAR-PLAN.md): the rows this scan already
  // fetched are handed to the recorder instead of being thrown away. It returns at once (one
  // settings read while switched off), never throws and makes no request of its own; the try is
  // a second belt so a recorder fault can never cost a scan.
  try {
    require("./marketData").tap({
      game,
      at: new Date(),
      ownGf: String((ctx && ctx.gfOwnerId) || ""),
      gfSold: gfSoldRel,
      gfActive: gfActiveRel,
      // Only a page the scout read in full proves a missing rival is gone (a failed fetch is [] without the flag).
      gfActiveComplete: !!(gfActive && gfActive.complete === true),
      gg: ggRel,
      pl: plRel,
    });
  } catch {
    /* the recorder must never be able to fail a scan */
  }
`,
  },
];

function count(hay, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

/** Pure: returns { status: "applied"|"already"|"refused", src, problems } */
function applyHunks(src, hunks, marker) {
  if (src.includes(marker)) return { status: "already", src, problems: [] };
  const problems = [];
  for (const h of hunks) {
    const n = count(src, h.old);
    if (n !== 1) problems.push(h.label + ": anchor matches " + n + " time(s), need exactly 1");
  }
  if (problems.length) return { status: "refused", src, problems };
  let out = src;
  for (const h of hunks) out = out.replace(h.old, () => h.new);
  return { status: "applied", src: out, problems: [] };
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith("--"));
  const write = argv.includes("--write");
  if (files.length !== 2) {
    console.error("usage: apply-market-radar-hooks.js <priceScout.js> <marketResearch.js> [--write]");
    return 2;
  }
  const plans = [
    { file: files[0], hunks: SCOUT_HUNKS, marker: SCOUT_MARKER },
    { file: files[1], hunks: TAP_HUNKS, marker: TAP_MARKER },
  ];
  const results = plans.map((p) => ({ ...p, ...applyHunks(fs.readFileSync(p.file, "utf8"), p.hunks, p.marker) }));
  let bad = false;
  for (const r of results) {
    console.log(r.file + ": " + r.status + (r.problems.length ? " — " + r.problems.join("; ") : ""));
    if (r.status === "refused") bad = true;
  }
  if (bad) {
    console.log("nothing written: every anchor must match exactly once");
    return 1;
  }
  const changed = results.filter((r) => r.status === "applied");
  if (!changed.length) console.log("nothing to write: both hooks are already in place");
  else if (write) {
    for (const r of changed) fs.writeFileSync(r.file, r.src);
    console.log("written: " + changed.map((r) => r.file).join(", "));
  } else console.log("dry run (add --write to apply)");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { applyHunks, SCOUT_HUNKS, TAP_HUNKS, SCOUT_MARKER, TAP_MARKER };
