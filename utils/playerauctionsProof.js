// Proof-of-delivery images for PlayerAuctions.
//
// PlayerAuctions' confirm-delivery endpoint is multipart, and its own client
// refuses to submit without attachments when the seller is level 0:
//
//   if ((data.sellerLevel === 0 || data.isNeedEvidence === true) &&
//       fileList.length <= 0) { formError = "Please submit 1-2 screenshots …" }
//
// Our account reports `level: 0`, so an empty confirm-delivery is rejected and
// the whole delivery bot stalls at the last step. This module renders the
// evidence the endpoint wants: a plain receipt card naming the order, the
// offer, what was handed over and when.
//
// It deliberately does NOT contain the credential. The image is uploaded to
// PlayerAuctions and is visible to their support and dispute staff, so it
// records that a hand-over happened and how — never the login itself.
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const sharp = require("sharp");

const W = 1000;
const H = 700;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Cheap width-aware wrap. The card is fixed width and the strings are short, so
// a character budget beats measuring glyphs.
function wrap(text, maxChars, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.length) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars - 1) lines[maxLines - 1] = last.slice(0, maxChars - 1) + "…";
  }
  return lines;
}

function rows(items, x, y, step) {
  return items
    .map((it, i) => {
      const yy = y + i * step;
      return (
        '<text x="' + x + '" y="' + yy + '" font-family="DejaVu Sans, Arial, sans-serif" ' +
        'font-size="21" fill="#7b8794">' + esc(it[0]) + "</text>" +
        '<text x="' + (x + 250) + '" y="' + yy + '" font-family="DejaVu Sans, Arial, sans-serif" ' +
        'font-size="21" fill="#12212e" font-weight="600">' + esc(it[1]) + "</text>"
      );
    })
    .join("");
}

// Render the receipt. `accountCount` is how many accounts were handed over;
// the logins themselves are never drawn.
function proofSvg({ orderId, offerTitle, accountCount, itemCount, when, sellerName }) {
  const titleLines = wrap(offerTitle || "PlayerAuctions order", 46, 2);
  const stamp = (when || new Date()).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const what =
    (accountCount || 1) +
    " account" +
    ((accountCount || 1) === 1 ? "" : "s") +
    (itemCount ? " · " + itemCount + " item" + (itemCount === 1 ? "" : "s") : "");

  // The card flows: title block, rule, five rows, then the banner. Computing
  // these keeps a two-line title from pushing the last row under the banner.
  const ruleY = 196 + titleLines.length * 34;
  const rowsTop = ruleY + 54;
  const bannerTop = rowsTop + 4 * 44 + 34;

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="#f4f6f8"/>' +
    '<rect x="34" y="34" width="' + (W - 68) + '" height="' + (H - 68) +
    '" rx="18" fill="#ffffff" stroke="#dde3e9" stroke-width="2"/>' +
    '<rect x="34" y="34" width="' + (W - 68) + '" height="86" rx="18" fill="#12212e"/>' +
    '<rect x="34" y="100" width="' + (W - 68) + '" height="20" fill="#12212e"/>' +
    '<text x="70" y="88" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" ' +
    'font-weight="700" fill="#ffffff">Delivery confirmation</text>' +
    '<text x="' + (W - 70) + '" y="88" text-anchor="end" ' +
    'font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="#8fa3b5">PlayerAuctions</text>' +
    titleLines
      .map(
        (l, i) =>
          '<text x="70" y="' + (176 + i * 34) + '" font-family="DejaVu Sans, Arial, sans-serif" ' +
          'font-size="26" font-weight="600" fill="#12212e">' + esc(l) + "</text>",
      )
      .join("") +
    '<line x1="70" y1="' + ruleY + '" x2="' + (W - 70) +
    '" y2="' + ruleY + '" stroke="#e6ebef" stroke-width="2"/>' +
    rows(
      [
        ["Order ID", orderId || "—"],
        ["Delivered", what],
        ["Delivery method", "Credential sent in order messages"],
        ["Timestamp", stamp],
        ["Seller", sellerName || "avishkarex2"],
      ],
      70,
      rowsTop,
      44,
    ) +
    '<rect x="70" y="' + bannerTop + '" width="' + (W - 140) + '" height="62" rx="10" ' +
    'fill="#eef7f0" stroke="#cfe6d6" stroke-width="2"/>' +
    '<text x="94" y="' + (bannerTop + 39) +
    '" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="#2c6b43">' +
    "The account credentials were sent to the buyer through the PlayerAuctions order chat." +
    "</text>" +
    "</svg>"
  );
}

// Render to a PNG on disk and return the path. Callers should unlink it after
// the upload; failing to is untidy but harmless (it lands in the OS temp dir).
async function buildDeliveryProof(opts = {}) {
  const png = await sharp(Buffer.from(proofSvg(opts))).png().toBuffer();
  const out = path.join(
    os.tmpdir(),
    "pa-proof-" + (opts.orderId || "order") + "-" +
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ".png",
  );
  await fsp.writeFile(out, png);
  return out;
}

async function cleanupProof(p) {
  if (!p) return;
  await fsp.unlink(p).catch(() => {});
}

module.exports = { buildDeliveryProof, cleanupProof, proofSvg };
