const fs = require("node:fs/promises"),
  path = require("node:path");
const { digest, validId, publishableReport } = require("./rivalsAccounts");
function category(name) {
  return /chrono/i.test(name)
    ? "Chrono Token drops"
    : /costume/i.test(name)
      ? "Costume rewards"
      : /emote$/i.test(name)
        ? "Emotes"
        : /nameplate/i.test(name)
          ? "Nameplates"
          : /spray/i.test(name)
            ? "Sprays"
            : /emoji/i.test(name)
              ? "Emojis"
              : /mood/i.test(name)
                ? "Moods"
                : "Other";
}
function validate(prep, manifest, audit) {
  if (
    !Number.isFinite(Date.parse(manifest?.createdAt)) ||
    !Number.isFinite(Date.parse(audit?.observedAt))
  )
    throw Error("Evidence dates required");
  if (
    !prep ||
    prep.status !== "held" ||
    !validId(prep._id) ||
    !publishableReport(prep.gameReport)
  )
    throw Error("Completed held preparation required");
  if (
    manifest.sourceManifestUid !== prep.gameReport.rivalsUid ||
    audit.rivalsUid !== prep.gameReport.rivalsUid
  )
    throw Error("Presentation account mismatch");
  if (
    !Array.isArray(manifest.images) ||
    !manifest.images.length ||
    manifest.images.length > 5 ||
    new Set(manifest.images.map((p) => p.file)).size !== manifest.images.length
  )
    throw Error("One to five distinct images required");
  for (const p of manifest.images)
    if (
      !/^[a-z0-9-]+\.png$/.test(p.file || "") ||
      !/^[a-f0-9]{64}$/.test(p.sha256 || "") ||
      !["overview", "original-contact-sheet", "original-receipt"].includes(
        p.kind,
      ) ||
      typeof p.label !== "string" ||
      p.label.length > 180
    )
      throw Error("Invalid presentation image");
  if (
    !Array.isArray(audit.drops) ||
    audit.drops.length > 1000 ||
    !prep.expectedRewards.every((r) => audit.drops.some((d) => d.id === r.id))
  )
    throw Error("Twitch inventory does not match the verified reward manifest");
  const groups = {},
    items = [];
  for (const d of audit.drops) {
    if (
      typeof d.name !== "string" ||
      d.name.length > 180 ||
      !Number.isSafeInteger(d.count) ||
      d.count < 1 ||
      d.state !== "connected"
    )
      throw Error("Invalid Twitch reward record");
    const kind = category(d.name);
    groups[kind] = (groups[kind] || 0) + d.count;
    items.push({ name: d.name, count: d.count, category: kind });
  }
  const receipt = manifest.images.find(
    (p) => p.kind === "original-receipt" && p.sha256 === manifest.receiptSha256,
  );
  if (
    !receipt ||
    !Number.isSafeInteger(manifest.receivedChronoTokens) ||
    manifest.receivedChronoTokens < 0
  )
    throw Error(
      "Original game claim receipt required for received-token amount",
    );
  return {
    presentation: {
      version: 2,
      sourceManifestUid: manifest.sourceManifestUid,
      createdAt: new Date(manifest.createdAt),
      images: manifest.images.map((p) => ({
        file: p.file,
        sha256: p.sha256,
        kind: p.kind,
        label: p.label,
      })),
    },
    rewardAudit: {
      source: "Twitch inventory; not a substitute for in-game verification",
      observedAt: new Date(audit.observedAt),
      total: audit.drops.length,
      groups,
      items,
      receivedChronoTokens: manifest.receivedChronoTokens,
      currencyEvidence: {
        kind: "game-claim-receipt",
        file: receipt.file,
        sha256: receipt.sha256,
      },
    },
  };
}
async function importPresentation(db, id, assetDir, audit, proofRoot) {
  const prep = await db.collection("rivalspreparations").findOne({ _id: id });
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(assetDir, "presentation-manifest.json"),
      "utf8",
    ),
  );
  const result = validate(prep, manifest, audit);
  const target = path.join(proofRoot, id);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const p of result.presentation.images) {
    const bytes = await fs.readFile(path.join(assetDir, p.file));
    if (bytes.length > 10000000 || digest(bytes) !== p.sha256)
      throw Error("Image checksum or10MB limit failed");
    try {
      await fs.writeFile(path.join(target, p.file), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (
        e.code !== "EEXIST" ||
        digest(await fs.readFile(path.join(target, p.file))) !== p.sha256
      )
        throw Error("Stored presentation file differs");
    }
  }
  const r = await db.collection("rivalspreparations").updateOne(
    {
      _id: id,
      status: "held",
      steamId: prep.steamId,
      twitchId: prep.twitchId,
      "gameReport.rivalsUid": prep.gameReport.rivalsUid,
    },
    { $set: result },
  );
  if (r.matchedCount !== 1) throw Error("Preparation changed during import");
  return {
    images: result.presentation.images.length,
    rewards: result.rewardAudit.total,
    receivedChronoTokens: result.rewardAudit.receivedChronoTokens,
  };
}
module.exports = { category, validate, importPresentation };
