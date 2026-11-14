const crypto = require("crypto");
const RL_ID = "30921";
function fail(message) {
  const e = new Error(message);
  e.user = true;
  e.status = 400;
  throw e;
}
function clean(value, max = 140) {
  const s = String(value || "").trim();
  if (s.length > max || /[\x00-\x08\x0b-\x1f<>]/.test(s))
    fail("Use plain text within the field limit");
  return s;
}
function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 60)
    fail("Enter 1–60 observed inventory items");
  const seen = new Set();
  return items.map((i) => {
    if (!i || typeof i !== "object")
      fail("Every inventory item needs a name and positive whole quantity");
    const name = clean(i.name, 80),
      paint = clean(i.paint, 35),
      certification = clean(i.certification, 35);
    if ([name, paint, certification].some((v) => /[\r\n\t]/.test(v)))
      fail("Keep each inventory field on one line");
    if (
      !name ||
      !Number.isInteger(Number(i.count)) ||
      +i.count < 1 ||
      +i.count > 10000
    )
      fail("Every inventory item needs a name and positive whole quantity");
    const kind = String(i.kind || "other");
    if (!["reward", "body", "goal", "decal", "other"].includes(kind))
      fail("Unknown inventory item type");
    const key = crypto
      .createHash("sha256")
      .update([name, paint, certification, kind].join("|").toLowerCase())
      .digest("hex")
      .slice(0, 24);
    if (seen.has(key))
      fail("Combine duplicate inventory rows into one quantity");
    seen.add(key);
    return { key, name, count: +i.count, kind, paint, certification };
  });
}
function validateProfile(p = {}) {
  if (!p || typeof p !== "object") fail("Record the observed game profile");
  const region = clean(p.region, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(region))
    fail("Record the account’s two-letter region");
  if (
    p.level == null ||
    String(p.level).trim() === "" ||
    typeof p.level === "boolean" ||
    !Number.isInteger(+p.level) ||
    +p.level < 0 ||
    +p.level > 10000
  )
    fail("Enter the observed account level");
  if (
    p.credits == null ||
    String(p.credits).trim() === "" ||
    typeof p.credits === "boolean" ||
    !Number.isInteger(+p.credits) ||
    +p.credits < 0 ||
    +p.credits > 1000000
  )
    fail("Enter the observed credits");
  const rank = clean(p.rank, 40);
  if (!rank || /[\r\n\t]/.test(rank)) fail("Enter the observed rank");
  return { region, level: +p.level, rank, credits: +p.credits, platform: "PC" };
}
// Anonymous Eldorado library metadata verified 2026-11-15:
// GET /api/library/1/Account/attributes/offers. Numeric credits use K units
// with precision 1; exact credits remain in the listing's description.
function marketplaceSection(profile) {
  const p = validateProfile(profile);
  if (p.level > 5000) fail("Eldorado supports observed levels from 0 to 5000");
  if (p.credits > 10000)
    fail("Eldorado supports observed credit balances from 0 to 10000");
  const ranks = {
    unranked: "rank-unranked",
    bronze: "rank-bronze",
    silver: "rank-silver",
    gold: "rank-gold",
    platinum: "rank-platinum",
    diamond: "rank-diamond",
    champion: "rank-champion",
    "grand champion": "rank-grand-champion",
    "supersonic legend": "rank-supersonic-legend",
  };
  const rank = ranks[p.rank.toLowerCase()];
  if (!rank) fail("Record a supported exact rank before publishing");
  const level =
    p.level <= 9
      ? "level-09"
      : p.level <= 49
        ? "level-1049"
        : p.level <= 99
          ? "level-5099"
          : p.level <= 499
            ? "level-100499"
            : p.level <= 1000
              ? "level-5001000"
              : "level-other";
  const credits =
    p.credits <= 299
      ? "credits-0299"
      : p.credits <= 999
        ? "credits-300999"
        : "credits-1000plus";
  return {
    key: "rocket-league",
    name: "Rocket League accounts (PC)",
    gameId: "1",
    tradeEnvironmentId: "0",
    seoAlias: "rocket-league-accounts-for-sale",
    offerAttributes: [
      { id: "rl-credits", type: "Select", values: [credits] },
      {
        id: "rocket-league-credits-numeric",
        type: "Numeric",
        value: Math.round(p.credits / 100) / 10,
      },
      { id: "rocket-league-current-rank", type: "Select", values: [rank] },
      { id: "rocket-league-level", type: "Select", values: [level] },
      { id: "rocket-league-level-numeric", type: "Numeric", value: p.level },
      // No particular season/title is asserted. An adopted offer preserves its
      // actual title attributes in the service rather than replacing them.
      {
        id: "rocket-league-tags-titles",
        type: "Select",
        values: ["tag-other"],
      },
    ],
  };
}
function claimedSnapshot(result, identity) {
  if (
    !result ||
    !identity ||
    !/^\d+$/.test(String(identity.twitchId || "")) ||
    !/^[a-z0-9_]+$/i.test(String(identity.twitchLogin || "")) ||
    !Array.isArray(result.drops)
  )
    fail("A complete Twitch identity and live inventory are required");
  if (
    String(result.twitchId) !== String(identity.twitchId) ||
    String(result.login).toLowerCase() !==
      String(identity.twitchLogin).toLowerCase()
  )
    fail("Twitch scan returned a different identity; verify the account link");
  const rl = result.drops.filter((d) => d && String(d.gameId) === RL_ID);
  if (rl.some((d) => d.connected === false))
    fail("Rocket League is disconnected on Twitch; verify the link again");
  const out = {};
  for (const d of rl) {
    // inProgressClaimed.count is an entitlement LIMIT, not a receipt count.
    // Wait for Twitch’s cumulative awarded inventory instead of guessing.
    if (
      d.source !== "gameEventDrop" ||
      d.connected !== true ||
      !d.benefitId ||
      typeof d.count === "boolean" ||
      !Number.isSafeInteger(+d.count) ||
      +d.count < 1 ||
      /expired/i.test(String(d.name || ""))
    )
      continue;
    const key = crypto
      .createHash("sha256")
      .update(String(d.benefitId))
      .digest("hex")
      .slice(0, 24);
    const v = { key, name: clean(d.name, 80), count: +d.count, kind: "other" };
    if (!v.name || /[\r\n\t]/.test(v.name))
      fail("Twitch returned an invalid reward name");
    if (out[key] && (out[key].name !== v.name || out[key].count !== v.count))
      fail("Twitch returned conflicting reward counts");
    out[key] = v;
  }
  return out;
}
function reconcileRewards(
  inventory,
  snapshot,
  { baseline = false, now = new Date() } = {},
) {
  const old = inventory || {};
  const highWater = { ...(old.highWater || {}) };
  for (const [k, v] of Object.entries(snapshot)) {
    if (!highWater[k] || +v.count > +highWater[k].count)
      highWater[k] = { ...v, observedAt: now };
  }
  const base = baseline ? { ...highWater } : { ...(old.baseline || {}) };
  const pending = Object.entries(highWater).flatMap(([k, v]) => {
    const count = +v.count - +(base[k]?.count || 0);
    return count > 0 ? [{ key: k, name: v.name, count, kind: "other" }] : [];
  });
  return {
    ...old,
    baseline: base,
    highWater,
    pending,
    lastScanAt: now,
    scanError: "",
    baselineAt: baseline ? now : old.baselineAt,
  };
}
function itemLine(i) {
  return `${i.count} × ${[i.paint, i.name].filter(Boolean).join(" ")}${i.certification ? ` (${i.certification})` : ""}`;
}
function content(skin) {
  const verified = skin.inventory?.verified || [],
    pending = skin.inventory?.pending || [];
  const rewards = verified
    .filter((i) => i.kind === "reward")
    .reduce((n, i) => n + i.count, 0);
  const highlights = verified
    .filter((i) => ["body", "goal"].includes(i.kind))
    .slice(0, 2)
    .map((i) => [i.paint, i.name].filter(Boolean).join(" "));
  const title = [
    "Rocket League PC",
    ...highlights,
    rewards ? `${rewards} Unopened Rewards` : "Verified Inventory",
    skin.profile?.region || "",
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 160);
  const lines = [
    `Whole Rocket League Epic Games account + linked Twitch account. PC | ${skin.profile?.region || "Region not verified"} | Level ${skin.profile?.level ?? "unverified"} | ${skin.profile?.rank || "Rank unverified"} | ${skin.profile?.credits == null ? "Credits unverified" : skin.profile.credits + " credits"}.`,
    "",
    "VERIFIED IN-GAME INVENTORY",
    ...verified.map(itemLine),
  ];
  if (verified.some((i) => /apex collection/i.test(i.name)))
    lines.push(
      "Apex Collection is unopened; its resulting item/colour is unknown.",
    );
  if (pending.length)
    lines.push(
      "",
      "ADDITIONAL TWITCH REWARDS — AWAITING GAME CHECK",
      ...pending.map((i) => itemLine({ count: i.count, name: i.name })),
      "Claimed on the linked Twitch account; expected in Rocket League after the next login, not yet checked in-game. Painted colours and certifications are unverified.",
    );
  lines.push(
    "",
    "Instant delivery: Epic login/password and linked Twitch login/password. Epic-only email-code viewer for 14 days after purchase; change the Epic email to your own. Original Epic/Outlook and Twitch email inboxes are NOT included. No future rewards or farming service included.",
  );
  const description = lines.join("\n");
  const problems = [];
  if (!verified.length || !skin.inventory?.verifiedAt)
    problems.push("Confirm the observed game inventory");
  if (!skin.inventory?.baselineAt)
    problems.push("Capture the Twitch reward baseline");
  if (skin.link?.status !== "verified")
    problems.push("Verify the exact Epic and Twitch link");
  if (skin.ownershipStatus !== "owned" || skin.soldAt || skin.state === "sold")
    problems.push("This pair is not available for sale");
  if (
    !Number.isInteger(skin.profile?.level) ||
    skin.profile.level < 0 ||
    !Number.isInteger(skin.profile?.credits) ||
    skin.profile.credits < 0 ||
    !skin.profile?.rank
  )
    problems.push("Verify the level, rank and credits in game");
  try {
    marketplaceSection(skin.profile);
  } catch (e) {
    problems.push(e.message);
  }
  if (!/^[A-Z]{2}$/.test(skin.profile?.region || ""))
    problems.push("Verify the region");
  if (description.length > 2000)
    problems.push(
      "Inventory text exceeds the marketplace limit; shorten item names without omitting items",
    );
  return {
    title,
    description,
    priceUsd: skin.listingPriceUsd || skin.pricing?.basePriceUsd || 4.99,
    canPublish: !problems.length,
    problems,
  };
}
function contentHash(preview) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([preview.title, preview.description]))
    .digest("hex");
}
module.exports = {
  clean,
  validateItems,
  validateProfile,
  marketplaceSection,
  claimedSnapshot,
  reconcileRewards,
  content,
  contentHash,
  RL_ID,
};
