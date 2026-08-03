// Fake-identity generator for extension-driven Epic Games signups.
// Pure functions, crypto-random, zero network calls. See EpicSignupSession
// for how the returned identity flows through the pipeline.
const crypto = require("crypto");

const { firstNames, lastNames } = require("./epicNameCorpus");

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%*?";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function pick(arr) {
  return arr[crypto.randomInt(0, arr.length)];
}

function pickChar(pool) {
  return pool[crypto.randomInt(0, pool.length)];
}

// 16-char password guaranteed to satisfy Epic's rule (>=8 chars, upper +
// lower + digit + symbol). Ambiguous chars (0/O, 1/l/I) removed so a
// buyer who reads the credentials out loud has an easier time.
function generatePassword() {
  const required = [
    pickChar(UPPER),
    pickChar(LOWER),
    pickChar(DIGITS),
    pickChar(SYMBOLS),
  ];
  const rest = Array.from({ length: 12 }, () => pickChar(ALL));
  const chars = required.concat(rest);
  // Fisher–Yates shuffle so required chars aren't always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Uniform on [minAge, maxAge] years old today, formatted YYYY-MM-DD. Skips
// Feb 29 to avoid Epic's leap-year edge case in the DOB picker.
function generateDateOfBirth(minAge = 22, maxAge = 40) {
  const now = new Date();
  const year =
    now.getUTCFullYear() -
    minAge -
    crypto.randomInt(0, maxAge - minAge + 1);
  let month = crypto.randomInt(0, 12); // 0-11
  let day = crypto.randomInt(1, 29); // 1-28, safe on any month
  if (month === 1 && day === 29) day = 28;
  const iso =
    String(year) +
    "-" +
    String(month + 1).padStart(2, "0") +
    "-" +
    String(day).padStart(2, "0");
  return iso;
}

// Display name is what other Epic users see. 3-16 chars, alphanumeric plus
// hyphen/underscore. Epic checks uniqueness; the extension retries by
// asking the server for a fresh one on collision.
function buildDisplayName(firstName) {
  const base = firstName.toLowerCase();
  const suffix = String(crypto.randomInt(100, 10000));
  const combined = base + suffix;
  return combined.length > 16 ? combined.slice(0, 16) : combined;
}

function build() {
  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  return {
    firstName,
    lastName,
    displayName: buildDisplayName(firstName),
    dateOfBirth: generateDateOfBirth(),
    country: "US",
    password: generatePassword(),
  };
}

module.exports = { build, buildDisplayName, generatePassword };
