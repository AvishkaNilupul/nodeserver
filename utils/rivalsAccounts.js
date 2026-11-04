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
function hasRetainedSession(report) {
  const s = report?.sessionRetention;
  return (
    report?.state === "verified" &&
    report.phase === "verified" &&
    s?.mode === "owner-retained" &&
    Number.isFinite(Date.parse(s.requestedAt)) &&
    typeof s.reason === "string" &&
    s.reason.trim().length >= 20 &&
    s.reason.length <= 500
  );
}
function publishableReport(report) {
  return (
    (report?.state === "ready" && report.phase === "logged-out") ||
    hasRetainedSession(report)
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
  if (!publishableReport(report) || !/^\d{6,20}$/.test(report.rivalsUid || ""))
    throw Error(
      "Complete game verification and sign-out or record the owner's session-retention request first",
    );
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
  for (const k of hasRetainedSession(report)
    ? ["verifiedAt"]
    : ["completedAt", "verifiedAt"])
    if (!Number.isFinite(Date.parse(report[k])))
      throw Error("Verification dates required");
  return {
    version: 1,
    rivalsUid: report.rivalsUid,
    phase: report.phase,
    state: report.state,
    verifiedAt: new Date(report.verifiedAt),
    completedAt: hasRetainedSession(report)
      ? null
      : new Date(report.completedAt),
    ...(hasRetainedSession(report)
      ? {
          sessionRetention: {
            mode: "owner-retained",
            requestedAt: new Date(report.sessionRetention.requestedAt),
            reason: report.sessionRetention.reason.trim(),
          },
        }
      : {}),
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
  if (prep.listingId)
    return prep.publishState === "uncertain"
      ? ["Publication needs reconciliation; do not retry"]
      : [];
  const b = [];
  if (prep.status !== "held") b.push("Stock hold needs review");
  if (!publishableReport(prep.gameReport))
    b.push("Finish game claims, inventory checks and sign-out");
  if (
    !steam ||
    steam.stage !== "problem" ||
    !String(steam.notes || "").includes(prep._id) ||
    steam.soldAt
  )
    b.push("Steam hold changed");
  if (permission?.canSell !== true) b.push("Check Eldorado selling access");
  if (!prep.deliveryAudit?.ok)
    b.push("Check site email delivery before publishing");
  return b;
}
function draft(prep, steam) {
  const proofs = prep.gameReport?.proofs || [];
  const price = Number(prep.draftPriceUsd) || 7.99;
  const country = steam?.storeCountry || null;
  const groups = new Map();
  for (const p of proofs) {
    if (!groups.has(p.costume)) groups.set(p.costume, []);
    groups.get(p.costume).push(p.hero.replace(/\s+MSF26$/i, ""));
  }
  const tail = ` | ${proofs.length} Skins | Marvel Rivals PC Steam`;
  const costumeNames = [...groups.keys()].map((n) => n.replace(/[()]/g, ""));
  let leading = costumeNames.join(" + ");
  if (leading.length + tail.length > 160)
    leading =
      costumeNames.find((n) => n.length + tail.length <= 160) ||
      "Verified Costumes";
  const heroes = [];
  for (const p of proofs) {
    const h = p.hero.replace(/\s+MSF26$/i, "");
    if (leading.toLowerCase().includes(h.toLowerCase()) || heroes.includes(h))
      continue;
    if ((leading + " | " + [...heroes, h].join(" ") + tail).length <= 160)
      heroes.push(h);
  }
  const title = proofs.length
    ? leading + (heroes.length ? " | " + heroes.join(" ") : "") + tail
    : "Marvel Rivals PC Steam | Verification pending";
  const currency =
    prep.rewardAudit?.currencyEvidence?.kind === "game-claim-receipt"
      ? prep.rewardAudit.receivedChronoTokens
      : null;
  const description = [
    "Marvel Rivals game account on PC through Steam.",
    `Steam country: ${country || "not yet verified"}. Store purchases may depend on this country.`,
    "Fresh game profile; no ranked-ready or ranked progression claim.",
    "",
    "Costumes already claimed and verified in the actual game inventory:",
    ...[...groups].map(
      ([name, heroes]) =>
        `- ${name}${heroes.length === 1 && name.toLowerCase().includes(heroes[0].toLowerCase()) ? "" : ": " + heroes.join(", ")}`,
    ),
    "",
    "The screenshots show this account's actual owned costumes. These rewards are already in game; no Twitch watch or drop claim is required for the listed costumes.",
    ...(Number.isSafeInteger(currency) && currency > 0
      ? [
          "",
          "BONUS REWARDS",
          `${currency.toLocaleString("en-US")} Chrono Tokens received in the recorded Claim-All receipt. These are seasonal Battle Pass tokens, not Units or Lattice; the receipt records the amount received, not a permanent currency balance.`,
          "Additional claimed Twitch cosmetics include sprays, nameplates, emotes, emojis and moods. The seven costumes above are the inventory-verified skin promise.",
        ]
      : []),
    ...(prep.deliveryAudit?.ok
      ? [
          "",
          "INSTANT DELIVERY",
          "Steam username and password plus a private mail-page login are delivered on your Eldorado order.",
          `${prep.deliveryAudit.sessionDays} days of access to Steam Guard and email-change emails from purchase. The original Outlook inbox is not included.`,
          "Change the Steam password and linked email to your own after delivery. Use the private mail page for the confirmation codes.",
          "Steam signup country: " +
            (steam?.signupCountry || "unverified") +
            ". Finalized Steam Store country is not guaranteed. Please wait at least 1 month after receiving the account before making purchases on the Steam Store.",
          "For support, contact us through your Eldorado order.",
        ]
      : ["Check the existing site email delivery flow before publishing."]),
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
function publicRow(prep, steam, permission, listing = null) {
  const r = prep.gameReport;
  return {
    id: prep._id,
    status: prep.status,
    publishState: prep.publishState || "draft",
    delivery: prep.deliveryAudit
      ? {
          ok: prep.deliveryAudit.ok,
          days: prep.deliveryAudit.sessionDays,
          checkedAt: prep.deliveryAudit.checkedAt,
        }
      : null,
    listing: listing
      ? {
          id: String(listing._id),
          url: listing.url,
          status: listing.status,
          priceUsd: listing.priceUsd,
        }
      : null,
    steamAccountId: String(prep.steamId),
    twitchAccountId: String(prep.twitchId),
    twitchLogin: prep.twitchLogin,
    rivalsUid: r?.rivalsUid || null,
    phase: r?.phase || "Not imported",
    verifiedAt: r?.verifiedAt || null,
    completedAt: r?.completedAt || null,
    sessionRetention: r?.sessionRetention || null,
    expectedCount: prep.expectedRewards?.length || 0,
    verifiedCount: r?.proofs?.length || 0,
    presentation: (prep.presentation?.images || []).map((p) => ({
      label: p.label,
      kind: p.kind,
      url: `/api/rivals/preparations/${encodeURIComponent(prep._id)}/proof/${encodeURIComponent(p.file)}`,
    })),
    rewards: prep.rewardAudit
      ? {
          source:
            "Twitch claim history; game inventory verification is separate",
          total: prep.rewardAudit.total,
          groups: prep.rewardAudit.groups,
          items: prep.rewardAudit.items,
          receivedChronoTokens: prep.rewardAudit.receivedChronoTokens,
        }
      : null,
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
  hasRetainedSession,
  publishableReport,
  validId,
  validateReport,
  publicRow,
  draft,
  blockers,
  digest,
};
