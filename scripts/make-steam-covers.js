#!/usr/bin/env node
// Renders the Eldorado covers for fresh Steam accounts (one offer per region,
// docs/STEAM-SALES.md): public/img/steam-cover.jpg (no region) and
// public/img/steam-cover-<cc>.jpg per country.
//
// Square on purpose: Eldorado shows offer covers in a square box (phone and
// desktop), so a wide image loses its sides. Everything sits inside a 100 px
// margin. No Valve/Steam logo: the word is used only to say what the account is.
//
// Run on the Mac (it uses the Mac's Futura / Helvetica Neue fonts):
//   node scripts/make-steam-covers.js JP US AR ...
// No country codes = the generic cover only.
const path = require("path");
const sharp = require("sharp");

const OUT = path.join(__dirname, "..", "public", "img");
const S = 1200;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Names too long for the region pill.
const SHORT = { AE: "UAE", GB: "UK", US: "USA", BA: "BOSNIA", DO: "DOMINICAN REP.", PS: "PALESTINE" };

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
  const region = cc ? regionName(cc).toUpperCase() + " REGION" : "EMAIL CODES INCLUDED";
  const regionSize = fit(region, 720, 56);
  const chips = ["EMAIL CODES", "INSTANT DELIVERY"];
  const chipW = chips.map((c) => Math.round(c.length * 21 + 64));
  const gap = 22;
  let x = (S - (chipW.reduce((a, b) => a + b, 0) + gap * (chips.length - 1))) / 2;
  const chipSvg = chips
    .map((c, i) => {
      const w = chipW[i];
      const out =
        `<rect x="${x}" y="1018" width="${w}" height="70" rx="35" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>` +
        `<text x="${x + w / 2}" y="1064" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="30" letter-spacing="2" fill="#e3f1ff">${esc(c)}</text>`;
      x += w + gap;
      return out;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs>
  <radialGradient id="bg" cx="0.5" cy="0.3" r="0.9">
    <stop offset="0" stop-color="#1e4f78"/><stop offset="0.5" stop-color="#0f2236"/><stop offset="1" stop-color="#070d16"/>
  </radialGradient>
  <radialGradient id="gCyan" cx="0" cy="0.7" r="0.6"><stop offset="0" stop-color="#1fb6ff" stop-opacity="0.45"/><stop offset="1" stop-color="#1fb6ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="gViolet" cx="1" cy="0.7" r="0.6"><stop offset="0" stop-color="#7a5cff" stop-opacity="0.4"/><stop offset="1" stop-color="#7a5cff" stop-opacity="0"/></radialGradient>
  <linearGradient id="pill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cf0b4"/><stop offset="1" stop-color="#33c98a"/></linearGradient>
  <linearGradient id="region" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1a9fff"/><stop offset="1" stop-color="#4a5cff"/></linearGradient>
  <linearGradient id="pad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9f3ff"/><stop offset="1" stop-color="#9fb6d3"/></linearGradient>
  <radialGradient id="padGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#66c6ff" stop-opacity="0.5"/><stop offset="1" stop-color="#66c6ff" stop-opacity="0"/></radialGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="b"/>
    <feFlood flood-color="#4fb8ff" flood-opacity="0.55"/><feComposite in2="b" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
<rect width="${S}" height="${S}" fill="url(#gCyan)"/>
<rect width="${S}" height="${S}" fill="url(#gViolet)"/>
<g stroke="#ffffff" stroke-opacity="0.06" stroke-width="2">
  ${Array.from({ length: 11 }, (_, i) => `<line x1="${i * 120}" y1="0" x2="${i * 120 - 300}" y2="${S}"/>`).join("")}
</g>
<circle cx="600" cy="345" r="210" fill="url(#padGlow)"/>
<g transform="translate(600 350)">
  <path d="M-170 -40 Q-170 -95 -115 -95 L115 -95 Q170 -95 170 -40 L190 70 Q200 125 150 125 Q115 125 95 85 L70 40 L-70 40 L-95 85 Q-115 125 -150 125 Q-200 125 -190 70 Z" fill="url(#pad)"/>
  <g fill="#1d3550">
    <rect x="-125" y="-22" width="70" height="22" rx="6"/>
    <rect x="-101" y="-46" width="22" height="70" rx="6"/>
    <circle cx="85" cy="-30" r="14"/><circle cx="120" cy="-2" r="14"/><circle cx="50" cy="-2" r="14"/><circle cx="85" cy="26" r="14"/>
  </g>
</g>
<rect x="390" y="104" width="420" height="74" rx="37" fill="url(#pill)"/>
<text x="600" y="155" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="34" letter-spacing="4" fill="#06231a">FRESH ACCOUNT</text>
<g filter="url(#glow)" font-family="Futura, Helvetica Neue, Arial, sans-serif" font-weight="900" text-anchor="middle" fill="#ffffff">
  <text x="600" y="745" font-size="230" letter-spacing="10">STEAM</text>
</g>
<text x="600" y="830" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="40" letter-spacing="6" fill="#bfe3ff">PC GAME ACCOUNT</text>
<rect x="150" y="886" width="900" height="100" rx="50" fill="url(#region)"/>
<g transform="translate(212 936)" stroke="#ffffff" stroke-width="5" fill="none" stroke-linejoin="round" opacity="0.95">
  ${cc ? '<circle r="28"/><ellipse rx="12" ry="28"/><line x1="-28" y1="0" x2="28" y2="0"/>' : '<rect x="-30" y="-21" width="60" height="42" rx="6"/><path d="M-28 -18 L0 4 L28 -18"/>'}
</g>
<text x="640" y="${936 + regionSize * 0.36}" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="${regionSize}" letter-spacing="2" fill="#ffffff">${esc(region)}</text>
${chipSvg}
</svg>`;
}

async function render(cc) {
  const file = path.join(OUT, "steam-cover" + (cc ? "-" + cc.toLowerCase() : "") + ".jpg");
  const info = await sharp(Buffer.from(svg(cc))).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
  console.log(path.relative(process.cwd(), file), info.width + "x" + info.height, Math.round(info.size / 1024) + " KB");
}

(async () => {
  const codes = process.argv.slice(2).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  await render("");
  for (const cc of codes) await render(cc);
})();
