// The Auto-farm tab's "Event bundles" panel (public/bots.html).
//
// The panel is inline browser JS with no module boundary, so this test lifts
// its render functions straight out of the page and exercises them in Node
// against a payload modelled on the real /auto-farm/bundles response. It
// exists because the panel builds HTML by string concatenation, which is
// exactly where escaping and attribute-quoting bugs hide — the apostrophe case
// below was a real one, caught here before it ever reached the browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "bots.html");
const START = "  /* Event bundles: a game's farmed WAVES sold as one bundle";
const END = "  function renderAutoFarmWatcher(snap) {";

function panelSource() {
  const html = fs.readFileSync(PAGE, "utf8");
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  assert.ok(
    from >= 0 && to > from,
    "the Event bundles panel is still in bots.html",
  );
  return html.slice(from, to);
}

// The handful of page helpers the panel calls, copied verbatim from bots.html.
const HELPERS = `
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function fmtNum(n){return Number(n||0).toLocaleString();}
  const window = {}; const $ = () => null; const api = async () => ({}); const toast = () => {};
`;

function run(tail) {
  return new Function(HELPERS + panelSource() + "\n" + tail)();
}

// Modelled on the prod dry run of 2026-09-08, plus two hostile names.
const PAYLOAD = {
  enabled: true,
  games: [
    {
      game: "Marvel Rivals",
      bundles: [
        {
          key: "marvel rivals|ignite msf 2026",
          event: "Ignite MSF 2026",
          full: true,
          wavesHeld: 4,
          wavesTotal: 4,
          wavesUnresolved: 0,
          waves: ["Day 1", "Day 2", "Day 3", "Day 4"],
          items: 19,
          totalQty: 19,
          assigned: 72,
          title:
            "Marvel Rivals Twitch Drops — Ignite MSF 2026 COMPLETE BUNDLE (Day 1 + Day 2 + Day 3 + Day 4 · 19 Items)",
          price: 1.53,
          priceBasis: "platformGame",
          priceClamped: "",
          soldFloorUsd: 0,
          ready: 25,
          live: null,
        },
      ],
    },
    {
      // A real game name with an apostrophe, plus a hostile title.
      game: "Tom Clancy's Rainbow Six <Siege>",
      bundles: [
        {
          key: "k2",
          event: 'He said "hi" & left',
          full: false,
          wavesHeld: 2,
          wavesTotal: 5,
          wavesUnresolved: 1,
          waves: [],
          items: 3,
          totalQty: 6,
          assigned: 40,
          title: "<script>alert(1)</script>",
          price: null,
          priceBasis: "",
          priceClamped: "absolute",
          soldFloorUsd: 2.5,
          ready: 0,
          live: null,
        },
      ],
    },
    {
      game: "SMITE 2",
      bundles: [
        {
          key: "k3",
          event: "August",
          full: true,
          wavesHeld: 2,
          wavesTotal: 2,
          wavesUnresolved: 0,
          waves: ["Week 3", "Week 4"],
          items: 8,
          totalQty: 15,
          assigned: 18,
          title: "SMITE 2 …",
          price: 3.71,
          priceBasis: "rival",
          priceClamped: "",
          soldFloorUsd: 0,
          ready: null,
          live: {
            marketplace: "gameflip",
            externalId: "abc123",
            price: 3.71,
            title: "x",
          },
        },
      ],
    },
    {
      // Not live and never stock-checked — the only state showing "not checked".
      game: "ZEVENT",
      bundles: [
        {
          key: "k4",
          event: "ZEvent 2026",
          full: true,
          wavesHeld: 2,
          wavesTotal: 2,
          wavesUnresolved: 0,
          waves: [],
          items: 3,
          totalQty: 6,
          assigned: 18,
          title: "ZEVENT …",
          price: 1.59,
          priceBasis: "rival",
          priceClamped: "",
          soldFloorUsd: 0,
          ready: null,
          live: null,
        },
      ],
    },
  ],
};

const rendered = () =>
  run("_afBundles = " + JSON.stringify(PAYLOAD) + ";\nreturn afBundleRows();");

test("the panel renders before any data has arrived", () => {
  assert.match(run("return afBundleRows();"), /Loading/);
});

test("an empty fleet reads as empty, not broken", () => {
  const out = run(
    "_afBundles = {enabled:true,games:[]};\nreturn afBundleRows();",
  );
  assert.match(out, /No game has two or more farmed waves/);
  assert.match(out, /0 bundles across 0 games/);
});

test("the summary counts live, ready and checked separately", () => {
  const out = rendered();
  assert.match(out, /4 bundles across 4 games/);
  assert.match(out, /1 live/);
  // Live bundles and never-checked ones are both excluded from "checked".
  assert.match(out, /1 of 2 checked have free stock/);
  assert.match(out, /publishing ON/);
});

test("each stock state gets its own chip", () => {
  const out = rendered();
  assert.match(out, /READY 25/);
  assert.match(out, /no free holder/);
  assert.match(out, /not checked/);
  assert.match(out, /Live on gameflip abc123/);
});

test("prices, floors and clamps render without NaN or undefined", () => {
  const out = rendered();
  assert.match(out, /\$1\.53/);
  assert.match(out, /\$3\.71/);
  assert.match(out, /—<\/b><span>Price/, "a null price is a dash, never NaN");
  assert.match(out, /sold floor \$2\.50/);
  assert.match(out, /clamped: absolute/);
  assert.ok(
    !/NaN|undefined/.test(out),
    "no NaN/undefined leaked into the markup",
  );
});

test("wave labels and the unresolved-wave note are shown", () => {
  const out = rendered();
  assert.match(out, /unlabelled/);
  assert.match(out, /1 farmed wave\(s\) have unknown contents/);
});

test("hostile titles and game names are escaped, never rendered as markup", () => {
  const out = rendered();
  assert.ok(!out.includes("<script>alert(1)</script>"));
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&quot;hi&quot;/);
  assert.match(out, /&amp; left/);
  assert.ok(!out.includes("Rainbow Six <Siege>"));
});

// THE REGRESSION THIS FILE WAS WRITTEN FOR.
// encodeURIComponent leaves ! ' ( ) * - . _ ~ unescaped, so a game named
// "Tom Clancy's Rainbow Six Siege" — one this fleet actually farms — closed the
// single-quoted onclick string early and threw the moment the button was
// clicked. afAttrArg escapes the quote as %27.
test("a game name with an apostrophe cannot break out of the onclick", () => {
  const out = rendered();
  const clicks =
    out.match(/onclick="afBundleCheckStock\('([^']*)', this\)"/g) || [];
  assert.equal(clicks.length, 3, "one Check stock button per non-live card");
  for (const attr of clicks) {
    const payload = attr.match(/'([^']*)'/)[1];
    assert.ok(
      !/['"]/.test(payload),
      "no raw quote in the attribute: " + payload,
    );
    decodeURIComponent(payload); // must round-trip
  }
  assert.ok(
    clicks.some(
      (a) =>
        decodeURIComponent(a.match(/'([^']*)'/)[1]) ===
        "Tom Clancy's Rainbow Six <Siege>",
    ),
    "the apostrophe game name survives the round trip",
  );
});

test("the panel skeleton is wired into the watcher render", () => {
  const html = fs.readFileSync(PAGE, "utf8");
  assert.match(html, /afBundlesHtml\(\)/, "panel is rendered");
  assert.match(html, /afLoadBundles\(\);/, "and loaded after render");
  assert.ok(!run("return afBundlesHtml();").includes("undefined"));
});
