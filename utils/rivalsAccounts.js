const crypto = require("node:crypto");
const validId = (s) => typeof s === "string" && /^[\w-]{8,100}$/.test(s);
function sameSet(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    new Set(a).size === a.length &&
    a.length === b.length &&
    a.every((v) => b.includes(v))
  );
}
function validateReport(prep, report) {
  if (!prep || prep.status !== "held" || !validId(prep._id))
    throw Error("Existing stock hold required");
  if (
    !report ||
    report.id !== prep._id ||
    report.holdId !== prep.holdId ||
    report.steamAccountId !== String(prep.steamId) ||
    report.twitchAccountId !== String(prep.twitchId)
  )
    throw Error("Held account pair mismatch");
  if (
    report.state !== "ready" ||
    report.phase !== "logged-out" ||
    !/^\d{6,20}$/.test(report.rivalsUid || "")
  )
    throw Error("Complete game verification and sign-out first");
  if (
    !prep.expectedRewards?.length ||
    !sameSet(
      report.verifiedRewards,
      prep.expectedRewards.map((r) => r.id),
    )
  )
    throw Error("Reward verification mismatch");
  if (
    prep.gameReport?.rivalsUid &&
    prep.gameReport.rivalsUid !== report.rivalsUid
  )
    throw Error("Game profile changed");
  if (
    !Array.isArray(report.proofs) ||
    report.proofs.length !== prep.expectedRewards.length
  )
    throw Error("Every costume needs a screenshot");
  if (
    !sameSet(
      report.proofs.map((p) => p.rewardId),
      report.verifiedRewards,
    )
  )
    throw Error("Screenshot reward mapping mismatch");
  if (new Set(report.proofs.map((p) => p.file)).size !== report.proofs.length)
    throw Error("Each costume needs its own screenshot");
  for (const p of report.proofs)
    if (
      !/^[a-z0-9-]+\.png$/.test(p.file || "") ||
      !/^[a-f0-9]{64}$/.test(p.sha256 || "") ||
      typeof p.costume !== "string" ||
      !p.costume.trim() ||
      p.costume.length > 120
    )
      throw Error("Invalid costume proof");
  for (const k of ["completedAt", "verifiedAt"])
    if (!Number.isFinite(Date.parse(report[k])))
      throw Error("Verification dates required");
  return {
    version: 1,
    rivalsUid: report.rivalsUid,
    phase: "logged-out",
    state: "ready",
    verifiedAt: new Date(report.verifiedAt),
    completedAt: new Date(report.completedAt),
    proofs: report.proofs.map((p) => ({
      rewardId: p.rewardId,
      file: p.file,
      sha256: p.sha256,
      costume: p.costume,
      hero: String(p.hero || "").slice(0, 80),
    })),
  };
}
function blockers(prep, steam, permission) {
  const b = [];
  if (prep.status !== "held") b.push("Stock hold needs review");
  if (
    !prep.gameReport ||
    prep.gameReport.state !== "ready" ||
    prep.gameReport.phase !== "logged-out"
  )
    b.push("Finish game claims, inventory checks and sign-out");
  if (
    !steam ||
    steam.stage !== "problem" ||
    !String(steam.notes || "").includes(prep._id) ||
    steam.soldAt
  )
    b.push("Steam hold changed");
  if (permission?.canSell !== true) b.push("Check Eldorado selling access");
  b.push("Configure and verify buyer account/email delivery before publishing");
  return b;
}
function draft(prep, steam) {
  const proofs = prep.gameReport?.proofs || [];
  const price = Number(prep.draftPriceUsd) || 7.99;
  const country = steam?.storeCountry || null;
  const title = `Marvel Rivals PC Steam | ${proofs.length} Claimed Costumes | Fresh Account`;
  const description = [
    "Marvel Rivals game account on PC through Steam.",
    `Steam country: ${country || "not yet verified"}. Store purchases may depend on this country.`,
    "Fresh game profile; no ranked-ready or ranked progression claim.",
    "",
    "Costumes already claimed and verified in the actual game inventory:",
    ...proofs.map((p) => `- ${p.hero}: ${p.costume}`),
    "",
    "The screenshots show this account's actual owned costumes. These rewards are already in game; no Twitch watch or drop claim is required for the listed costumes.",
    "Buyer account and email delivery details must be finalized before this draft is published.",
  ].join("\n");
  return {
    title,
    description,
    priceUsd: price,
    estimatedFeeUsd: Math.ceil(price * 100 * 0.1 - 1e-9) / 100,
    estimatedNetUsd:
      Math.round((price - Math.ceil(price * 10 - 1e-9) / 100) * 100) / 100,
    gameId: "227",
    category: "Account",
    tradeEnvironmentId: "9-0",
    categoryLabel: "Fresh Account / PC",
    country,
  };
}
function publicRow(prep, steam, permission) {
  const r = prep.gameReport;
  return {
    id: prep._id,
    status: prep.status,
    steamAccountId: String(prep.steamId),
    twitchAccountId: String(prep.twitchId),
    twitchLogin: prep.twitchLogin,
    rivalsUid: r?.rivalsUid || null,
    phase: r?.phase || "Not imported",
    verifiedAt: r?.verifiedAt || null,
    completedAt: r?.completedAt || null,
    expectedCount: prep.expectedRewards?.length || 0,
    verifiedCount: r?.proofs?.length || 0,
    proofs: (r?.proofs || []).map((p) => ({
      hero: p.hero,
      costume: p.costume,
      url: `/api/rivals/preparations/${encodeURIComponent(prep._id)}/proof/${encodeURIComponent(p.file)}`,
    })),
    draft: draft(prep, steam),
    blockers: blockers(prep, steam, permission),
  };
}
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
module.exports = {
  validId,
  validateReport,
  publicRow,
  draft,
  blockers,
  digest,
};
