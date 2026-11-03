// One-shot "fingerprint" of a Discord account: pulls /users/@me plus the
// quiet usage-trace endpoints that reveal whether an account is pristine or
// has prior history. Called on first login (intake) and again on each
// scheduled health check so we can detect state changes over time.

const { discordRequest } = require("./discordHttp");

// Discord epoch (2015-01-01T00:00:00Z) in ms — subtract this from a snowflake
// to get the account's true creation date, regardless of what the seller
// claimed in the listing.
const DISCORD_EPOCH_MS = 1420070400000;

function snowflakeToDate(id) {
  if (!id) return null;
  try {
    const bi = BigInt(id);
    const ms = Number(bi >> 22n) + DISCORD_EPOCH_MS;
    return new Date(ms);
  } catch { return null; }
}

async function fetchOne(session, path) {
  const r = await discordRequest(session.host, {
    method: "GET",
    path,
    headers: {
      Authorization: session.token,
      "User-Agent": (session.fingerprint && session.fingerprint.ua) || "Mozilla/5.0",
      "X-Super-Properties": (session.fingerprint && session.fingerprint.xsp) || "",
      Accept: "*/*",
    },
    timeout: 20000,
    proxy: session.proxy,
  });
  return r;
}

// Pull /users/@me plus the small quiet endpoints that give a "pristine or
// not" signal. We ignore endpoints that reliably come back empty (library,
// mentions, mfa/webauthn/credentials) — they add noise without new signal.
// Returns a normalised structure the model layer can persist directly.
async function probeAccount(session) {
  const started = Date.now();
  const [me, guilds, conns, bills, affU, quests] = await Promise.all([
    fetchOne(session, "/api/v9/users/@me"),
    fetchOne(session, "/api/v9/users/@me/guilds"),
    fetchOne(session, "/api/v9/users/@me/connections"),
    fetchOne(session, "/api/v9/users/@me/billing/subscriptions"),
    fetchOne(session, "/api/v9/users/@me/affinities/users"),
    fetchOne(session, "/api/v9/quests/@me"),
  ]);
  if (me.status !== 200) {
    const code = me.data && me.data.code;
    if (code === 0 || me.status === 401) {
      return { state: "disabled-or-token-invalid", httpStatus: me.status, probedAt: new Date() };
    }
    throw new Error("probeAccount /users/@me HTTP " + me.status + " " + JSON.stringify(me.data).slice(0, 300));
  }
  const u = me.data;
  const live = (quests.data && Array.isArray(quests.data.quests))
    ? quests.data.quests.filter((q) => {
        const exp = Date.parse(q.config && q.config.expires_at || 0);
        return exp && exp > Date.now();
      })
    : [];
  return {
    probedAt: new Date(),
    probeDurationMs: Date.now() - started,
    identity: {
      id: u.id,
      username: u.username,
      globalName: u.global_name || null,
      discriminator: u.discriminator,
      email: u.email || null,
      emailVerified: !!u.verified,
      phone: u.phone || null,
      locale: u.locale,
      mfaEnabled: !!u.mfa_enabled,
      publicFlags: Number(u.public_flags || 0),
      flags: Number(u.flags || 0),
      premiumType: Number(u.premium_type || 0),
      nsfwAllowed: !!u.nsfw_allowed,
      ageVerificationStatus: u.age_verification_status || null,
      storeCountry: (u.store_country && u.store_country.country) || null,
      snowflakeCreatedAt: snowflakeToDate(u.id),
    },
    trace: {
      guildCount: Array.isArray(guilds.data) ? guilds.data.length : null,
      connectionCount: Array.isArray(conns.data) ? conns.data.length : null,
      subscriptionCount: Array.isArray(bills.data) ? bills.data.length : null,
      affinityCount: (affU.data && Array.isArray(affU.data.user_affinities))
        ? affU.data.user_affinities.length : null,
    },
    quests: {
      enrollmentBlockedUntil: quests.data && quests.data.quest_enrollment_blocked_until,
      accessSuspendedUntil: quests.data && quests.data.quest_access_suspended_until,
      liveCount: live.length,
      liveIds: live.map((q) => q.id),
    },
    // Overall rollup — one word the admin dashboard can colour-code.
    state: deriveState(u, quests.data),
  };
}

function deriveState(u, questBag) {
  if (!u) return "unknown";
  if (!u.verified) return "email-unverified";
  if (!u.phone) return "phone-unverified";
  const flags = Number(u.flags || 0);
  // Discord USER_FLAG_SPAMMER = 1 << 20, DISABLED = (via account.disabled on
  // other endpoints — the user object doesn't carry it). Treat any non-zero
  // flags as a warning signal to inspect manually.
  if (flags & (1 << 20)) return "flagged-spammer";
  if (questBag && questBag.quest_enrollment_blocked_until) return "quest-blocked";
  if (questBag && questBag.quest_access_suspended_until) return "quest-suspended";
  return "alive";
}

module.exports = {
  probeAccount,
  snowflakeToDate,
  DISCORD_EPOCH_MS,
};
