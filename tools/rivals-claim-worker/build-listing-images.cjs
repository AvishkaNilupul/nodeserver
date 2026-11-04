// Deterministic layouts of original game captures. No generated game imagery.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const sharp = require("sharp");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const names = {
  "captain-america": "Captain America",
  "daredevil-msf26": "Daredevil · IGNITE (2026)",
  rogue: "Rogue",
  "squirrel-girl": "Squirrel Girl",
  storm: "Storm",
  wolverine: "Wolverine",
  "elsa-bloodstone": "Elsa Bloodstone",
};
const crops = {
  "captain-america": [760, 160, 480, 820],
  "daredevil-msf26": [830, 140, 450, 840],
  rogue: [760, 160, 450, 810],
  "squirrel-girl": [800, 130, 490, 860],
  storm: [600, 140, 760, 850],
  wolverine: [760, 180, 500, 800],
  "elsa-bloodstone": [780, 140, 620, 850],
};
function svg(width, height, body) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>text{font-family:Arial,Helvetica,sans-serif;fill:#f0f2ff} .muted{fill:#b4bfd8}</style>${body}</svg>`,
  );
}
function text(x, y, value, size = 36, extra = "") {
  return `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${xml(value)}</text>`;
}
async function build({ sourceDir, outDir, receiptPath, chronoTokensReceived }) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"),
  );
  const inputs = new Map();
  let resized = false;
  async function displayCapture(bytes) {
    const meta = await sharp(bytes).metadata();
    if (
      !meta.width ||
      !meta.height ||
      Math.abs(meta.width / meta.height - 1600 / 1035) > 0.01
    )
      throw Error("Capture aspect ratio does not match the costume layout");
    if (meta.width === 1600 && meta.height === 1035) return bytes;
    resized = true;
    return sharp(bytes).resize(1600, 1035, { fit: "fill" }).png().toBuffer();
  }
  for (const p of manifest.verifiedCostumes) {
    if (!names[p.hero] || !/^[a-z0-9-]+\.png$/.test(p.file))
      throw Error("Unknown screenshot mapping");
    const bytes = await fs.readFile(path.join(sourceDir, p.file));
    if (hash(bytes) !== p.sha256) throw Error("Original screenshot changed");
    inputs.set(p.hero, { ...p, bytes: await displayCapture(bytes) });
  }
  if (inputs.size !== 7) throw Error("All seven original captures required");
  const receiptSource = await fs.readFile(receiptPath);
  const receipt = await displayCapture(receiptSource);
  if (!Number.isSafeInteger(chronoTokensReceived) || chronoTokensReceived < 0)
    throw Error("Supply manually verified received-token amount");
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const images = [];
  async function save(file, bytes, kind, label, sources) {
    if (bytes.length > 10 * 1024 * 1024)
      throw Error("Listing image exceeds10MB");
    await fs.writeFile(path.join(outDir, file), bytes, { mode: 0o600 });
    images.push({
      file,
      sha256: hash(bytes),
      kind,
      label,
      bytes: bytes.length,
      sources,
    });
  }
  const order = [
    "daredevil-msf26",
    "rogue",
    "storm",
    "wolverine",
    "captain-america",
    "squirrel-girl",
    "elsa-bloodstone",
  ];
  // Overview uses explicit crops/resizing; complete source pixels are preserved
  // at1:1 in the two evidence sheets below.
  const coverLayers = [];
  let coverLabels =
    text(40, 65, "WILL OF GALACTA + IGNITE", 58, 'font-weight="bold"') +
    text(
      40,
      118,
      "7 inventory-verified costumes · PC / Steam",
      32,
      'class="muted"',
    );
  for (let i = 0; i < order.length; i++) {
    const hero = order[i],
      x = 24 + (i % 4) * 494,
      y = 166 + Math.floor(i / 4) * 622;
    const [left, top, width, height] = crops[hero];
    const portrait = await sharp(inputs.get(hero).bytes)
      .extract({ left, top, width, height })
      .resize(470, 548, { fit: "contain", background: "#192238" })
      .png()
      .toBuffer();
    coverLayers.push({ input: portrait, left: x, top: y });
    coverLabels += text(
      x + 10,
      y + 590,
      names[hero],
      hero === "daredevil-msf26" ? 24 : 29,
      'font-weight="bold"',
    );
  }
  const bonusX = 24 + 3 * 494,
    bonusY = 166 + 622;
  coverLabels +=
    `<rect x="${bonusX}" y="${bonusY}" width="470" height="606" rx="16" fill="#222e4a"/>` +
    text(
      bonusX + 28,
      bonusY + 110,
      "BONUS RECEIVED",
      32,
      'font-weight="bold"',
    ) +
    text(
      bonusX + 28,
      bonusY + 235,
      chronoTokensReceived.toLocaleString("en-US"),
      78,
      'font-weight="bold"',
    ) +
    text(bonusX + 28, bonusY + 298, "CHRONO TOKENS", 33) +
    text(
      bonusX + 28,
      bonusY + 388,
      "Claim-All receipt follows",
      26,
      'class="muted"',
    ) +
    text(
      bonusX + 28,
      bonusY + 440,
      "Seasonal Battle Pass currency",
      24,
      'class="muted"',
    );
  coverLabels += text(
    28,
    1480,
    "Costume overview · Full original inventory captures in the following images",
    25,
    'class="muted"',
  );
  coverLayers.push({ input: svg(2000, 1504, coverLabels), left: 0, top: 0 });
  await save(
    "costume-overview-v2.png",
    await sharp({
      create: { width: 2000, height: 1504, channels: 4, background: "#10182a" },
    })
      .composite(coverLayers)
      .removeAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer(),
    "overview",
    "7 verified costumes + received Chrono Tokens",
    order.map((h) => inputs.get(h).file),
  );
  async function sheet(file, rows, subtitle) {
    const layers = [],
      placements = [];
    let labels =
      text(28, 60, "ORIGINAL INVENTORY PROOF", 54, 'font-weight="bold"') +
      text(28, 116, subtitle, 30, 'class="muted"');
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i],
        left = 24 + (i % 2) * 1616,
        top = 206 + Math.floor(i / 2) * 1120;
      const display = await sharp(item.bytes)
        .flatten({ background: "#000000" })
        .png()
        .toBuffer();
      layers.push({ input: display, left, top });
      placements.push({ file: item.file, left, top, bytes: display });
      labels += text(left, top - 18, item.label, 32, 'font-weight="bold"');
    }
    labels += text(
      28,
      2410,
      resized
        ? "Full screenshots resized for this sheet · Unmodified originals retained privately"
        : "Original capture pixels preserved · Headers and borders added outside the screenshots",
      26,
      'class="muted"',
    );
    layers.push({ input: svg(3264, 2440, labels), left: 0, top: 0 });
    const bytes = await sharp({
      create: { width: 3264, height: 2440, channels: 4, background: "#10182a" },
    })
      .composite(layers)
      .removeAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();
    // Verify that the layout introduced no repainting or altered inventory text.
    for (const p of placements) {
      const actual = await sharp(bytes)
        .extract({ left: p.left, top: p.top, width: 1600, height: 1035 })
        .removeAlpha()
        .raw()
        .toBuffer();
      const original = await sharp(p.bytes).removeAlpha().raw().toBuffer();
      if (!actual.equals(original))
        throw Error("Evidence pixels changed during layout");
    }
    await save(
      file,
      bytes,
      "original-contact-sheet",
      subtitle,
      rows.map((r) => r.file),
    );
  }
  const item = (h) => ({
    ...inputs.get(h),
    label: names[h] + " · " + inputs.get(h).costume,
  });
  await sheet(
    "owned-costumes-sheet-1-v2.png",
    order.slice(0, 4).map(item),
    "Sheet1/2 · Daredevil, Rogue, Storm and Wolverine",
  );
  await sheet(
    "owned-costumes-sheet-2-v2.png",
    [
      ...order.slice(4).map(item),
      {
        bytes: receipt,
        file: path.basename(receiptPath),
        label: `Claim-All receipt · ${chronoTokensReceived.toLocaleString("en-US")} Chrono Tokens received`,
      },
    ],
    "Sheet2/2 · Captain America, Squirrel Girl, Elsa Bloodstone and claim receipt",
  );
  await save(
    "claimed-bonus-rewards-v2.png",
    receipt,
    "original-receipt",
    "Actual Claim-All receipt",
    [path.basename(receiptPath)],
  );
  const result = {
    version: 2,
    createdAt: new Date().toISOString(),
    source: "Deterministic Sharp layout; no generated or repainted game images",
    sourceManifestUid: manifest.rivalsUid,
    images,
    receivedChronoTokens: chronoTokensReceived,
    receiptSha256: hash(receipt),
    receiptSourceSha256: hash(receiptSource),
    captureLayout: resized
      ? "Full captures resized to1600x1035; source files unchanged"
      : "Original1600x1035 pixels preserved",
  };
  await fs.writeFile(
    path.join(outDir, "presentation-manifest.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  return result;
}
if (require.main === module) {
  const [sourceDir, outDir, receiptPath, amount] = process.argv.slice(2);
  build({
    sourceDir,
    outDir,
    receiptPath,
    chronoTokensReceived: Number(amount),
  })
    .then((r) =>
      console.log(
        JSON.stringify({
          images: r.images.map(({ file, bytes, sha256 }) => ({
            file,
            bytes,
            sha256,
          })),
          pixelVerification:
            r.captureLayout +
            "; all seven display captures and receipt match exactly in contact sheets",
        }),
      ),
    )
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
module.exports = { build };
