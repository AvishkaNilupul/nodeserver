"use strict";
// Code shop — store-credit vouchers (2026-11-02).
//
// Some stream events pay out store credit instead of a game item. CHZZK's
// "N Connector" event gave a Nexon Cash 3,000 KRW coupon for watching any of
// four games, Overwatch among them. The ledger files a code under the game of
// the stream it was earned on, so that coupon was listed as "Overwatch 2": the
// buyer gets credit for a Korean Nexon wallet, which no Overwatch account can
// use. Store credit is never a game reward, so:
//   - the planner never drafts a bundle with one (planner.js), and
//   - the buyer-text guard refuses a product whose title or a label names one
//     (textGuard.js), which also stops approve, publish and resume.
// The codes stay in stock and in the panel; the owner decides what to do.
// Pure: no database, no network.

const VOUCHER_PATTERNS = Object.freeze([
  /넥슨\s*캐시/,
  /\bnexon\s*cash\b/i,
  /네이버\s*페이/,
  /\bnaver\s*pay\b/i,
  /네이버\s*포인트/,
  /\bnaver\s*points?\b/i,
  /상품권/, // gift certificates: 문화상품권, 도서문화상품권, …
  /컬처\s*랜드/,
  /\bculture\s*land\b/i,
  /해피\s*머니/,
  /\bhappy\s*money\b/i,
  /기프티콘/,
  /\bgifticon\b/i,
  /기프트\s*카드/,
  /\bgift\s*cards?\b/i,
  /구글\s*(?:플레이\s*)?기프트/,
  /\bgoogle\s*play\s*(?:gift|credit)/i,
  /별풍선/, // SOOP's tipping currency
  /\bstar\s*balloons?\b/i,
  /\d[\d,]*\s*치즈(?![가-힣])/, // CHZZK's tipping currency ("1,000 치즈")
  /치즈\s*\d/,
  /\d[\d,]*\s*원(?![가-힣])/, // a won amount ("3,000원")
  /\d\s*[천만]\s*원(?![가-힣])/, // "5천원", "1만원"
  /\d[\d,]*\s*KRW\b/i,
  /\bKRW\s*\d/i,
]);

const text = (v) => (v === undefined || v === null ? "" : String(v));

// The first piece of `values` that names store credit, or null.
function findVoucher(...values) {
  for (const v of values) {
    const s = text(v);
    if (!s) continue;
    for (const re of VOUCHER_PATTERNS) {
      const m = re.exec(s);
      if (m && m[0]) return m[0].trim();
    }
  }
  return null;
}

const isVoucher = (...values) => findVoucher(...values) !== null;

module.exports = { VOUCHER_PATTERNS, findVoucher, isVoucher };
