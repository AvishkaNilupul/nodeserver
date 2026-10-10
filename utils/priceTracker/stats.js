// Small, pure statistics helpers for the price tracker. Everything here is
// deliberately boring: the interesting decisions live in analyze.js, and a
// helper that is subtly wrong (an off-by-one quantile) would corrupt all of them.

const round2 = (n) => Math.round(n * 100) / 100;

function clean(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function median(values) {
  const a = clean(values);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return round2(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
}

// Nearest-rank quantile on the sorted positives. Same convention as
// marketPricing.band (floor(f * n), clamped), so figures agree across the site.
function quantile(values, f) {
  const a = clean(values);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(f * a.length))];
}

function band(values) {
  const a = clean(values);
  if (!a.length) return { n: 0, min: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0, mean: 0 };
  return {
    n: a.length,
    min: a[0],
    p25: quantile(a, 0.25),
    median: median(a),
    p75: quantile(a, 0.75),
    p90: quantile(a, 0.9),
    max: a[a.length - 1],
    mean: round2(a.reduce((x, y) => x + y, 0) / a.length),
  };
}

// Wilson score interval for a proportion. A conversion of "2 of 3" and "200 of
// 300" are the same 67% and nowhere near the same evidence; the page must not
// let a thin cell look as solid as a thick one. z = 1.28 (80%) on purpose: this
// is a decision aid for pricing nudges, not a publication.
function wilson(successes, total, z = 1.28) {
  const n = Number(total);
  if (!(n > 0)) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
}

const DAY = 86400000;

module.exports = { DAY, round2, clean, median, quantile, band, wilson };
