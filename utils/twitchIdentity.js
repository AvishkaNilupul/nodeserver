// A stable, per-account device identity for Twitch requests.
//
// The problem this solves: every call the fleet makes carries exactly three
// headers — Content-Type, Client-Id, Authorization. No User-Agent, no device
// id, nothing. So hundreds of accounts are byte-identical on the wire and
// trivially groupable into one cohort, and they're distinguishable from a real
// client by omission alone.
//
// Everything here is derived deterministically from the account's immutable
// _id, so an account's device never changes and nothing has to be stored or
// migrated. IDENTITY_VERSION pins the derivation: bumping it re-rolls every
// device in the fleet at once, which is exactly the sort of correlated event
// this file exists to avoid. Don't bump it casually.
//
// WHAT VARIES AND WHAT DOESN'T MATTERS.
//
// Over-randomising is its own tell. Real populations vary in some dimensions
// and agree in others:
//   - X-Device-Id      per account, forever      (this is the big one — it is
//                                                 what actually groups devices)
//   - User-Agent       per account               (real users own different
//                                                 phones; varying this is
//                                                 realistic, not suspicious)
//   - Accept-Language  per account, low variety  (skewed to en-US like reality)
//   - Client-Session-Id per session              (a new one each sitting, like
//                                                 a fresh app launch)
//   - Client-Version   NOT per account           (everyone on the same app
//                                                 build; a fleet where every
//                                                 account reports a different
//                                                 version would be absurd)
//
// The Client-Id stays whatever the caller passes. It is NOT a knob: these
// tokens are minted through device-auth against Twitch's Android app client,
// and swapping in the web client id makes the integrity-gated queries fail
// outright ("failed integrity check" — verified against a live token). The
// identity below is therefore Android-shaped, to agree with it.
const crypto = require("crypto");

const IDENTITY_VERSION = "v1";

function h(seed, salt) {
  return crypto
    .createHash("sha256")
    .update(IDENTITY_VERSION + "|" + salt + "|" + String(seed))
    .digest("hex");
}

// Deterministic integer in [0, n) from a seed+salt.
function pick(seed, salt, n) {
  return parseInt(h(seed, salt).slice(0, 8), 16) % n;
}

// Real, current-ish Android handsets, weighted toward what's actually common.
// Each entry pairs a model string with the Android release it plausibly runs.
const DEVICES = [
  { model: "SM-S918B", build: "UP1A.231005.007", android: "14" }, // Galaxy S23 Ultra
  { model: "SM-S911B", build: "UP1A.231005.007", android: "14" }, // Galaxy S23
  { model: "SM-A546B", build: "UP1A.231005.007", android: "14" }, // Galaxy A54
  { model: "SM-A336B", build: "TP1A.220624.014", android: "13" }, // Galaxy A33
  { model: "SM-G991B", build: "TP1A.220624.014", android: "13" }, // Galaxy S21
  { model: "Pixel 7", build: "TQ3A.230805.001", android: "13" },
  { model: "Pixel 7a", build: "UQ1A.240105.004", android: "14" },
  { model: "Pixel 6a", build: "TQ3A.230805.001", android: "13" },
  { model: "Pixel 8", build: "UQ1A.240105.004", android: "14" },
  { model: "M2101K6G", build: "TP1A.220624.014", android: "13" }, // Redmi Note 10 Pro
  { model: "22021211RG", build: "TP1A.220624.014", android: "13" }, // Redmi Note 11
  { model: "2201117TY", build: "TP1A.220624.014", android: "13" }, // Redmi Note 11
  { model: "CPH2451", build: "TP1A.220905.001", android: "13" }, // OnePlus 11
  { model: "RMX3371", build: "TP1A.220624.014", android: "13" }, // Realme GT
  { model: "V2111", build: "TP1A.220624.014", android: "13" }, // vivo
  { model: "moto g84 5G", build: "U1TDS34.ived", android: "14" },
];

// Chrome builds shipped in Android WebView. Small set on purpose — the whole
// population does not run sixteen different Chrome versions.
const CHROME_BUILDS = ["120.0.6099.210", "121.0.6167.101", "122.0.6261.64"];

// Twitch Android app versions. Deliberately few: a real fleet is mostly on the
// latest one or two builds.
const APP_VERSIONS = ["19.4.1", "19.3.0"];

// Skewed hard toward en-US, as any real English-speaking population is.
const LANGUAGES = [
  "en-US", "en-US", "en-US", "en-US", "en-US", "en-US",
  "en-GB", "en-GB",
  "de-DE", "fr-FR", "es-ES", "pt-BR", "pl-PL", "ru-RU",
];

// A 32-char lowercase hex device id — the shape Twitch's own clients use.
function deviceIdFor(seed) {
  return h(seed, "device").slice(0, 32);
}

// Stable per-account handset + browser string.
function userAgentFor(seed) {
  const d = DEVICES[pick(seed, "device-model", DEVICES.length)];
  const chrome = CHROME_BUILDS[pick(seed, "chrome", CHROME_BUILDS.length)];
  return (
    "Mozilla/5.0 (Linux; Android " + d.android + "; " + d.model +
    " Build/" + d.build + ") AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/" + chrome + " Mobile Safari/537.36"
  );
}

function languageFor(seed) {
  const l = LANGUAGES[pick(seed, "lang", LANGUAGES.length)];
  return l + "," + l.split("-")[0] + ";q=0.9";
}

function appVersionFor(seed) {
  return APP_VERSIONS[pick(seed, "appver", APP_VERSIONS.length)];
}

// New each time — a session id is per app launch, not per device.
function newSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

// The full stable identity for one account.
function identityFor(seed) {
  return {
    deviceId: deviceIdFor(seed),
    userAgent: userAgentFor(seed),
    acceptLanguage: languageFor(seed),
    clientVersion: appVersionFor(seed),
  };
}

// Headers to merge into a Twitch request for this account. `sessionId` should
// be held for the length of one logical sitting (one watch session) and then
// discarded, which is what a real app launch looks like.
//
// Returns only the identity headers — the caller still supplies Client-Id and
// Authorization, so this can never accidentally change which client we present
// as (see the note at the top about integrity).
function headersFor(seed, sessionId) {
  if (!seed) return {};
  const id = identityFor(seed);
  return {
    "User-Agent": id.userAgent,
    "Accept-Language": id.acceptLanguage,
    "X-Device-Id": id.deviceId,
    "Client-Version": id.clientVersion,
    ...(sessionId ? { "Client-Session-Id": sessionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Diurnal activity window
//
// Sessions were being scheduled uniformly across 24 hours, which no person does.
// Each account gets a stable waking window — a start hour (UTC) and a length —
// and the scheduler pushes anything that lands outside it to the next window.
// Windows are 11-16 hours, which is roughly a real waking day, and the start
// hour spreads across the clock so the fleet as a whole is active around the
// clock while each individual account is not.
// ---------------------------------------------------------------------------

function activeWindowFor(seed) {
  const startHour = pick(seed, "wake", 24);
  const hours = 11 + pick(seed, "awake-len", 6); // 11..16
  return { startHour, hours };
}

function isWithinWindow(date, win) {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const end = win.startHour + win.hours;
  if (end <= 24) return hour >= win.startHour && hour < end;
  // Window wraps past midnight.
  return hour >= win.startHour || hour < end - 24;
}

// Move `date` forward to the next moment inside the account's waking window,
// with a few random minutes of slop so window starts don't become their own
// synchronised spike. Returns `date` untouched when it already fits.
function nextWithinWindow(date, win) {
  if (isWithinWindow(date, win)) return date;
  const d = new Date(date.getTime());
  // Advance to the window's start hour today; if that's already past, tomorrow.
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(win.startHour);
  if (d.getTime() <= date.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  // Land somewhere in the first ~90 minutes of the window rather than exactly
  // on the hour.
  return new Date(d.getTime() + Math.floor(Math.random() * 90 * 60 * 1000));
}

module.exports = {
  IDENTITY_VERSION,
  identityFor,
  headersFor,
  newSessionId,
  deviceIdFor,
  userAgentFor,
  activeWindowFor,
  isWithinWindow,
  nextWithinWindow,
};
