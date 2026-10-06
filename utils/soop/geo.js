// Where the SOOP egress is, and what to claim in the bridge handshake.
//
// SOOP credits watch time only when the country claimed in the handshake is the
// one it sees for the connection, AND that country is one it pays drops in
// (measured 2026-10-04: JP yes, LK yes, US no). So the claim is read back from
// SOOP itself (the caller passes the lookup in) and never guessed: v1 cached a
// "JP" fallback for the whole process when the lookup failed, after which the
// account sat on a bridge earning nothing.
const { SoopError } = require("./errors");

// ISO 3166-1 alpha-2 -> numeric, as the 3-digit string the handshake wants.
const ISO_NUMERIC = Object.freeze({
  AD: "020", AE: "784", AF: "004", AL: "008", AM: "051", AO: "024", AR: "032",
  AT: "040", AU: "036", AZ: "031", BA: "070", BD: "050", BE: "056", BG: "100",
  BH: "048", BN: "096", BO: "068", BR: "076", BT: "064", BY: "112", CA: "124",
  CH: "756", CI: "384", CL: "152", CM: "120", CN: "156", CO: "170", CR: "188",
  CU: "192", CY: "196", CZ: "203", DE: "276", DK: "208", DO: "214", DZ: "012",
  EC: "218", EE: "233", EG: "818", ES: "724", ET: "231", FI: "246", FJ: "242",
  FR: "250", GB: "826", GE: "268", GH: "288", GR: "300", GT: "320", GU: "316",
  HK: "344", HN: "340", HR: "191", HU: "348", ID: "360", IE: "372", IL: "376",
  IN: "356", IQ: "368", IR: "364", IS: "352", IT: "380", JM: "388", JO: "400",
  JP: "392", KE: "404", KG: "417", KH: "116", KR: "410", KW: "414", KZ: "398",
  LA: "418", LB: "422", LI: "438", LK: "144", LT: "440", LU: "442", LV: "428",
  LY: "434", MA: "504", MC: "492", MD: "498", ME: "499", MK: "807", MM: "104",
  MN: "496", MO: "446", MT: "470", MV: "462", MX: "484", MY: "458", MZ: "508",
  NG: "566", NI: "558", NL: "528", NO: "578", NP: "524", NZ: "554", OM: "512",
  PA: "591", PE: "604", PG: "598", PH: "608", PK: "586", PL: "616", PR: "630",
  PS: "275", PT: "620", PY: "600", QA: "634", RO: "642", RS: "688", RU: "643",
  SA: "682", SD: "729", SE: "752", SG: "702", SI: "705", SK: "703", SN: "686",
  SV: "222", SY: "760", TH: "764", TN: "788", TR: "792", TT: "780", TW: "158",
  TZ: "834", UA: "804", UG: "800", US: "840", UY: "858", UZ: "860", VE: "862",
  VN: "704", YE: "887", ZA: "710", ZM: "894", ZW: "716",
});

const DEFAULT_JOIN_CC = "392";
const DEFAULT_GEO_RC = "13";

// Only what has been measured; everything else is honestly unknown.
const CREDITED = Object.freeze({ JP: "yes", LK: "yes", US: "no" });

// "jp " -> "JP"; anything that is not two letters -> "".
function cleanCc(cc) {
  const s = typeof cc === "string" ? cc.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(s) ? s : "";
}

function numericFor(cc) {
  return ISO_NUMERIC[cleanCc(cc)] || null;
}

function creditStatus(cc) {
  return CREDITED[cleanCc(cc)] || "unknown";
}

function createGeoResolver({
  ttlMs = 30 * 60 * 1000,
  env = process.env,
  now = Date.now,
} = {}) {
  let cached = null; // { cc, at } — the last successful lookup
  let inflight = null;
  let generation = 0; // bumped by invalidate() so a lookup in flight is not cached

  // The join/region overrides are applied on the way out, so they follow the
  // environment even for a country that is already cached.
  const claim = (cc) => ({
    cc,
    joinCc: env.SOOP_JOIN_CC || numericFor(cc) || DEFAULT_JOIN_CC,
    geoRc: env.SOOP_GEO_RC || DEFAULT_GEO_RC,
  });

  const pinned = () => (env.SOOP_GEO_CC ? String(env.SOOP_GEO_CC).trim() : "");

  async function lookup(fetchCountry) {
    const started = generation;
    let cc;
    try {
      cc = cleanCc(await fetchCountry());
    } catch (err) {
      throw new SoopError(
        `could not read the egress country: ${(err && err.message) || err}`,
        { code: "EGRESS", cause: err },
      );
    }
    if (!cc) {
      throw new SoopError("SOOP did not report a country for this connection", {
        code: "EGRESS",
      });
    }
    if (started === generation) cached = { cc, at: now() };
    return cc;
  }

  async function get(fetchCountry) {
    // A pinned country needs no lookup (and so cannot fail on one).
    const fixed = pinned();
    if (fixed) return claim(fixed);
    if (cached && now() - cached.at < ttlMs) return claim(cached.cc);
    if (!inflight) {
      const p = lookup(fetchCountry).finally(() => {
        if (inflight === p) inflight = null;
      });
      inflight = p;
    }
    return claim(await inflight);
  }

  // Last known answer without a lookup. Not expired by ttlMs — `at` is there so
  // the caller can judge its age; only invalidate() clears it.
  function peek() {
    const fixed = pinned();
    if (fixed) return { ...claim(fixed), at: now() };
    return cached ? { ...claim(cached.cc), at: cached.at } : null;
  }

  function invalidate() {
    generation += 1;
    cached = null;
    inflight = null;
  }

  return { get, peek, invalidate };
}

module.exports = { ISO_NUMERIC, numericFor, creditStatus, createGeoResolver };
