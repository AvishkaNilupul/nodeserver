#!/usr/bin/env node
// Renders the Eldorado covers for fresh Epic accounts listed in the Rocket
// League section: public/img/epic-rl-cover.jpg (country unknown) and
// public/img/epic-rl-cover-<cc>.jpg per country.
//
// Square on purpose: Eldorado shows offer covers in a square box (phone and
// desktop), so a wide image loses its sides. Everything sits inside a 100 px
// margin.
//
// Run on the Mac (it uses the Mac's Futura / Helvetica Neue fonts):
//   node scripts/make-epic-rl-covers.js JP US GB ...
// No country codes = the generic cover only.
const path = require("path");
const sharp = require("sharp");

const OUT = path.join(__dirname, "..", "public", "img");
const S = 1200;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Names too long for the region pill.
const SHORT = { AE: "UAE" };

function regionName(cc) {
  if (SHORT[cc]) return SHORT[cc];
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc;
  } catch {
    return cc;
  }
}

// Font size that keeps `text` inside `width` (bold caps with 2 px letter
// spacing measure about 0.76 em per character).
function fit(text, width, max) {
  return Math.min(max, Math.floor(width / (String(text).length * 0.76)));
}

function svg(cc) {
  // An account always has an Epic country; when we don't know it, the pill
  // says what the buyer gets instead of guessing a region.
  const region = cc ? regionName(cc).toUpperCase() + " REGION" : "EMAIL CODES INCLUDED";
  const regionSize = fit(region, 720, 54);
  const chips = ["UNRANKED", "LEVEL 0", "INSTANT DELIVERY"];
  const chipW = chips.map((c) => Math.round(c.length * 21 + 64));
  const gap = 22;
  let x = (S - (chipW.reduce((a, b) => a + b, 0) + gap * (chips.length - 1))) / 2;
  const chipSvg = chips
    .map((c, i) => {
      const w = chipW[i];
      const out =
        `<rect x="${x}" y="1018" width="${w}" height="70" rx="35" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>` +
        `<text x="${x + w / 2}" y="1064" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="30" letter-spacing="2" fill="#e8ecff">${esc(c)}</text>`;
      x += w + gap;
      return out;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs>
  <radialGradient id="bg" cx="0.5" cy="0.32" r="0.85">
    <stop offset="0" stop-color="#1d2f78"/><stop offset="0.45" stop-color="#0c1440"/><stop offset="1" stop-color="#050818"/>
  </radialGradient>
  <radialGradient id="gBlue" cx="0" cy="0.62" r="0.62"><stop offset="0" stop-color="#1f74ff" stop-opacity="0.65"/><stop offset="1" stop-color="#1f74ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="gOrange" cx="1" cy="0.62" r="0.62"><stop offset="0" stop-color="#ff6d1f" stop-opacity="0.6"/><stop offset="1" stop-color="#ff6d1f" stop-opacity="0"/></radialGradient>
  <linearGradient id="trailBlue" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b8cff" stop-opacity="0"/><stop offset="1" stop-color="#7fb4ff" stop-opacity="0.95"/></linearGradient>
  <linearGradient id="trailOrange" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#ff7a2e" stop-opacity="0"/><stop offset="1" stop-color="#ffb37a" stop-opacity="0.95"/></linearGradient>
  <linearGradient id="pill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffa13d"/><stop offset="1" stop-color="#ff6a1a"/></linearGradient>
  <linearGradient id="region" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2367ff"/><stop offset="1" stop-color="#5b3dff"/></linearGradient>
  <radialGradient id="ball" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#d6dcef"/><stop offset="1" stop-color="#8e99bd"/></radialGradient>
  <radialGradient id="ballGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#9cc2ff" stop-opacity="0.55"/><stop offset="1" stop-color="#9cc2ff" stop-opacity="0"/></radialGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="b"/>
    <feFlood flood-color="#6aa2ff" flood-opacity="0.55"/><feComposite in2="b" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
<rect width="${S}" height="${S}" fill="url(#gBlue)"/>
<rect width="${S}" height="${S}" fill="url(#gOrange)"/>
<g stroke="#ffffff" stroke-opacity="0.09" stroke-width="3" fill="none">
  <path d="M120 1160 L360 760 L840 760 L1080 1160"/>
  <line x1="600" y1="760" x2="600" y2="1160"/>
  <ellipse cx="600" cy="930" rx="190" ry="70"/>
</g>
<polygon points="0,700 560,612 560,640 0,760" fill="url(#trailBlue)" opacity="0.8"/>
<polygon points="1200,760 640,640 640,668 1200,820" fill="url(#trailOrange)" opacity="0.8"/>
<circle cx="600" cy="330" r="200" fill="url(#ballGlow)"/>
<circle cx="600" cy="330" r="112" fill="url(#ball)"/>
<g stroke="#6f7ba3" stroke-width="5" fill="none" stroke-linejoin="round" opacity="0.85">
  <polygon points="600,268 650,300 632,358 568,358 550,300"/>
  <path d="M600 268 L600 220 M650 300 L700 282 M632 358 L662 404 M568 358 L538 404 M550 300 L500 282"/>
</g>
<rect x="390" y="104" width="420" height="74" rx="37" fill="url(#pill)"/>
<text x="600" y="155" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="34" letter-spacing="4" fill="#160c02">FRESH ACCOUNT</text>
<g filter="url(#glow)" font-family="Futura, Helvetica Neue, Arial, sans-serif" font-weight="900" text-anchor="middle" fill="#ffffff">
  <text x="600" y="610" font-size="178" letter-spacing="2">ROCKET</text>
  <text x="600" y="770" font-size="178" letter-spacing="2">LEAGUE</text>
</g>
<text x="600" y="842" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="40" letter-spacing="6" fill="#c9d4ff">PC · EPIC GAMES ACCOUNT</text>
<rect x="150" y="886" width="900" height="100" rx="50" fill="url(#region)"/>
<g transform="translate(212 936)" stroke="#ffffff" stroke-width="5" fill="none" stroke-linejoin="round" opacity="0.95">
  ${cc ? '<circle r="28"/><ellipse rx="12" ry="28"/><line x1="-28" y1="0" x2="28" y2="0"/>' : '<rect x="-30" y="-21" width="60" height="42" rx="6"/><path d="M-28 -18 L0 4 L28 -18"/>'}
</g>
<text x="640" y="${936 + regionSize * 0.36}" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="${regionSize}" letter-spacing="2" fill="#ffffff">${esc(region)}</text>
${chipSvg}
</svg>`;
}

async function render(cc) {
  const file = path.join(OUT, "epic-rl-cover" + (cc ? "-" + cc.toLowerCase() : "") + ".jpg");
  const info = await sharp(Buffer.from(svg(cc))).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
  console.log(path.relative(process.cwd(), file), info.width + "x" + info.height, Math.round(info.size / 1024) + " KB");
}

(async () => {
  const codes = process.argv.slice(2).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  await render("");
  for (const cc of codes) await render(cc);
})();
