// Twitch cookie jars for SOOP cookie renewal: what one import brings, storing
// it, and linking it to the SOOP account it signs in to.
//
// A SOOP login made through Twitch can be signed in again from that Twitch
// login's twitch.tv cookies (utils/twitchOauthRefresher.js). Those cookies
// arrive from the SOOP page's "Twitch logins" dialog, one Twitch login per
// request, and are stored encrypted in TwitchWebCookie. Cookie values are
// never logged and never returned.
//
// Linking never overwrites: a SOOP account already renewing through another
// Twitch login, or a Twitch login already renewing another SOOP account, is
// reported and left as it is (the account panel changes a link by hand). A
// wrong link could not do harm anyway — a renewal whose Twitch login signs in
// to a different SOOP account is refused before anything is saved — but it
// would leave that account without renewal, so it is caught here too.
const SoopAccount = require("../../models/SoopAccount");
const TwitchWebCookie = require("../../models/TwitchWebCookie");
const { encrypt } = require("../secretBox");

// Twitch logins are 4–25 letters, digits and underscores; old ones can be shorter.
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
const isTwitch = (c) =>
  c && typeof c === "object" && typeof c.name === "string" && c.value != null && /(^|\.)twitch\.tv$/i.test(String(c.domain || "").trim());

// Only twitch.tv cookies are kept: the renewal sends nothing else.
function twitchCookies(list) {
  return (Array.isArray(list) ? list : []).filter(isTwitch);
}

// The Twitch login a jar is signed in as — twitch.tv keeps it in a cookie
// named `login`. "" when it is missing or is not a login name.
function loginOf(cookies) {
  const c = (cookies || []).find((x) => x && x.name === "login");
  const v = c ? String(c.value || "").trim().toLowerCase() : "";
  return LOGIN_RE.test(v) ? v : "";
}

function expiryOf(cookies, name) {
  const c = (cookies || []).find((x) => x && x.name === name);
  const s = c ? Number(c.expirationDate) : NaN;
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000) : null;
}

const daysLeft = (d, now = Date.now()) => (d ? +((d.getTime() - now) / 86400000).toFixed(1) : null);

// What the panel shows about a jar; no cookie value is in it.
function describe(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return {
    cookieCount: cookies.length,
    hasAuthToken: names.has("auth-token"),
    // Without the httpOnly `persistent` cookie the sign-in dies in days, not months.
    shortLived: !names.has("persistent"),
    persistentExpiresAt: expiryOf(cookies, "persistent"),
    authTokenExpiresAt: expiryOf(cookies, "auth-token"),
  };
}

// Upsert one Twitch login's jar. -> { created } (false: an older jar was replaced)
async function saveJar({ login, cookies, harvestedAt, source }) {
  const d = describe(cookies);
  const before = await TwitchWebCookie.findOneAndUpdate(
    { twitchLogin: login },
    {
      $set: {
        twitchLogin: login,
        cookies: encrypt(JSON.stringify(cookies)),
        cookieCount: d.cookieCount,
        shortLived: d.shortLived,
        persistentExpiresAt: d.persistentExpiresAt,
        authTokenExpiresAt: d.authTokenExpiresAt,
        harvestedAt: harvestedAt || new Date(),
        source: String(source || ""),
      },
    },
    { upsert: true, returnDocument: "before", setDefaultsOnInsert: true, projection: { _id: 1 } },
  );
  return { created: !before, ...d };
}

// Link a stored Twitch login to the SOOP account it signs in to.
// `soopId` blank: only say where the login is linked now, if anywhere.
// `setTwitchLogin(id, login)` is the farm's own writer (it drops its caches).
// -> { state, soopId?, other? }
//    linked     — linked now
//    already    — this pair was linked before
//    unlinked   — no SOOP account named, and none uses this login
//    no_account — the named SOOP account is not in the farm (import it first)
//    conflict   — the SOOP account renews through `other` Twitch login; left as it is
//    taken      — this Twitch login renews `other` SOOP account; left as it is
async function linkJar({ login, soopId }, setTwitchLogin) {
  const holders = await SoopAccount.find({ twitchLogin: login }).select("loginId").lean();
  if (!soopId) return holders.length ? { state: "already", soopId: holders[0].loginId } : { state: "unlinked" };
  const acc = await SoopAccount.findOne({ loginId: soopId }).select("loginId twitchLogin").lean();
  if (!acc) return { state: "no_account", soopId };
  if (acc.twitchLogin === login) return { state: "already", soopId };
  if (acc.twitchLogin) return { state: "conflict", soopId, other: acc.twitchLogin };
  const elsewhere = holders.find((h) => h.loginId !== soopId);
  if (elsewhere) return { state: "taken", soopId, other: elsewhere.loginId };
  const set = await setTwitchLogin(soopId, login);
  return set === null ? { state: "no_account", soopId } : { state: "linked", soopId };
}

module.exports = { LOGIN_RE, twitchCookies, loginOf, describe, daysLeft, saveJar, linkJar };
