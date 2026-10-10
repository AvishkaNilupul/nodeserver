// Buyer-facing copy for PlayerAuctions.
//
// PlayerAuctions caps an order message at 300 characters (50 for a brand-new
// member). Every other marketplace we deliver on takes a ~500-character
// hand-over, so the copy cannot simply be reused — the Eldorado text is 494
// characters and would be rejected outright.
//
// The split this module enforces:
//
//   offer.instruction  — the long claim guide. PlayerAuctions shows it to the
//                        buyer up front ("Provide instructions or details to
//                        your buyer in advance"), it has no length problem, and
//                        it renders on their own page so a URL in it is safe.
//   order message      — the credential and a one-line pointer. Nothing else
//                        fits, and splitting a credential across two messages
//                        races and risks a half-delivered order.
//
// Both builders below hard-guarantee the limit: they drop optional trailing
// sentences until the text fits, rather than truncating mid-credential.
const LIMIT = 300;
const { termWords, dayText, connectFirstShort } = require("./farmHandover");

// Assemble `head` (never dropped) plus as many `tail` sentences as fit.
// Returns the longest result within `limit`.
function fit(head, tail, limit = LIMIT) {
  let out = head;
  for (const s of tail) {
    // The head often ends in a deliberate blank line; only join with a space
    // when it does not already end in whitespace.
    const next = /\s$/.test(out) ? out + s : out + " " + s;
    if (next.length > limit) break;
    out = next;
  }
  return out;
}

function credLine(a) {
  return a.login + " / " + a.password;
}

// Credentials block. One account gets labelled lines; several get a compact
// numbered list, because five labelled pairs alone would blow the budget.
function credBlock(accounts) {
  if (accounts.length === 1) {
    return "Login: " + accounts[0].login + "\nPassword: " + accounts[0].password;
  }
  return accounts.map((a, i) => i + 1 + ") " + credLine(a)).join("\n");
}

// --- Bundle orders ------------------------------------------------------
// The buyer bought an account that already holds the drops, unclaimed.
function bundleDeliveryMessage(accounts) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const head =
    (list.length > 1 ? list.length + " accounts:\n" : "") + credBlock(list);
  return fit(head + "\n\n", [
    "Log in on Twitch, open Drops & Rewards > Inventory, and press Connect under each item to link it to your own game account.",
    "Full steps are in this offer's delivery instructions.",
    "Any problem, reply here first and I will make it right.",
  ]);
}

// --- Unclaimed bundle orders --------------------------------------------
// The no-claim farm's stock (and auto-farm accounts sold the same way): the
// drops were watched to 100% and never claimed, so there is nothing under
// "Received" yet. Since 2026-10-05 Twitch lets them be claimed only once the
// account is connected to the buyer's own game account, and keeps them only
// about 7 days after the event ends — so "connect first" and "claim today" are
// the two sentences that must survive the 300 characters, in that order.
function unclaimedDeliveryMessage(accounts) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const head =
    (list.length > 1 ? list.length + " accounts:\n" : "") + credBlock(list);
  return fit(head + "\n\n", [
    "On Twitch open Drops & Rewards > Inventory: FIRST press Connect and link your own game account, then press Claim on each drop.",
    "Claim today - unclaimed drops expire days after the event.",
    "Full steps are in this offer's delivery instructions.",
  ]);
}

// --- Rent-farm orders ---------------------------------------------------
// The buyer bought a window of automated farming on an account we keep running.
// The game is accepted (and ignored) so this matches farmInstruction's shape —
// naming it would not fit in 300 characters alongside the credential.
// `until` (the window's end, counted from this hand-over — utils/farmHandover)
// costs ~20 characters and is part of the head: the date the farming ends is
// what a buyer needs most after the login.
//
// Since 2026-10-05 Twitch refuses a claim from an account that is not linked to
// the game, so the first sentence after the login is the one the buyer must
// act on: connect first. It is tried with the game named, then without, so a
// long login never pushes it out of the 300 characters.
function farmDeliveryMessage(accounts, days, game, until = null) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const term = termWords(days);
  const head =
    (list.length > 1 ? list.length + " accounts:\n" : "") + credBlock(list) +
    "\n\nYour " + term + " of automatic farming starts now" +
    (until ? " (until " + dayText(until) + ")" : "") + ".";
  const rest = [
    "Do not change the password or email, or the farm stops.",
    "Details are in this offer's delivery instructions.",
  ];
  for (const connect of [connectFirstShort(game), connectFirstShort(""), "FIRST link your game account to it."]) {
    const out = fit(head, [connect].concat(rest));
    if (out.length > head.length) return out;
  }
  return head;
}

// --- The guide, for offer.instruction ---------------------------------
// PlayerAuctions caps `instruction` at 500 characters ("Delivery instructions
// should less than 500 characters"), so this is NOT the place for the full
// Eldorado claim guide either — it is a second, smaller budget rather than an
// unlimited one. The split that survives both caps:
//
//   title + description  — unlimited-ish, carries the sales copy and item list
//   instruction (<500)   — how to claim, shown to the buyer before they order
//   message (<=300)      — the credential and a pointer, nothing else
//
// No URL scheme here: "twitch.tv/..." rather than "https://twitch.tv/...",
// because a bare link is the kind of thing marketplaces strip, and the buyer
// can paste it either way.
const INSTRUCTION_LIMIT = 500;

function clampInstruction(text) {
  const t = String(text || "").trim();
  if (t.length <= INSTRUCTION_LIMIT) return t;
  // Trim on a paragraph boundary rather than mid-sentence.
  const cut = t.slice(0, INSTRUCTION_LIMIT);
  const stop = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return (stop > 200 ? cut.slice(0, stop) : cut).trim();
}

// `unclaimed` — the offer sells accounts whose drops are still unclaimed (a
// no-claim set): connect first, then claim, and soon.
function bundleInstruction(opts = {}) {
  if (opts && opts.unclaimed) return unclaimedInstruction();
  return clampInstruction(
    [
      "HOW TO CLAIM",
      "1. Log in to the Twitch account sent to you in the order messages.",
      "2. Open twitch.tv/drops/inventory",
      '3. Under "Received", click Connect on each item and link it to your own game account.',
      "",
      "If the event is still running, more items can still land on this account - our farm keeps collecting them, so leave it linked and check again in a day or two.",
      "",
      "Please do not change the password or email. Any problem, message me here first and I will make it right.",
    ].join("\n"),
  );
}

function unclaimedInstruction() {
  return clampInstruction(
    [
      "HOW TO CLAIM",
      "1. Log in to the Twitch account from the order messages.",
      "2. Open twitch.tv/drops/inventory - your drops are at the top, at 100%.",
      "3. FIRST press Connect and sign in with your own game account. Twitch only lets a connected account claim.",
      "4. Then press Claim Now on each drop.",
      "",
      "Claim today: Twitch removes unclaimed drops about 7 days after the event ends - the clock is already running.",
      "",
      "Do not change the password or email. Any problem, message me here first and I will make it right.",
    ].join("\n"),
  );
}

function farmInstruction(days, game) {
  const term = termWords(days);
  return clampInstruction(
    [
      "AUTOMATIC FARMING - " + term.toUpperCase(),
      "",
      "You get a Twitch account in the order messages. FIRST connect your own" +
        (game ? " " + game : " game") + " account to it: log in, open twitch.tv/drops/campaigns, find the game, press Connect. Twitch claims nothing for an unconnected account.",
      "",
      "Then our farm claims every drop automatically - no watching needed. Drops earned before you connect are claimed once you do.",
      "",
      "Do NOT change the password or email or the farm stops. Events under 24h are not guaranteed.",
    ].join("\n"),
  );
}

// --- Chunking, for orders too large for one message ---------------------
// A buyer can order several units at once, and past roughly nine accounts the
// credentials alone exceed 300 characters — at which point a single-message
// hand-over is impossible, not merely tight. Rather than fail the delivery,
// split the credentials across as few messages as possible and put the
// explanatory sentence on the last one.
//
// The caller MUST send every message before confirming delivery, and must
// reserve the accounts before sending, so that a failure part-way through
// resends the same credentials instead of claiming fresh ones.
// kind: "bundle" (claimed drops), "unclaimed" (drops still to be claimed — a
// no-claim offer) or "farm" (rent-farm).
function deliveryMessages(accounts, { kind = "bundle", days, game, until = null } = {}) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const single =
    kind === "farm"
      ? farmDeliveryMessage(list, days, game, until)
      : kind === "unclaimed"
        ? unclaimedDeliveryMessage(list)
        : bundleDeliveryMessage(list);
  if (single.length <= LIMIT) return [single];

  // Pack greedily: a header naming the range, then as many credentials as fit.
  const out = [];
  let i = 0;
  while (i < list.length) {
    const start = i;
    let body = "";
    let taken = 0;
    while (i < list.length) {
      const line = i + 1 + ") " + credLine(list[i]);
      const header =
        "Accounts " + (start + 1) + "-" + (i + 1) + " of " + list.length + ":\n";
      const next = body ? body + "\n" + line : line;
      if ((header + next).length > LIMIT) break;
      body = next;
      taken++;
      i++;
    }
    // A single credential longer than the whole budget cannot be sent at all.
    if (!taken) {
      throw new Error(
        "PlayerAuctions: credential for " + list[i].login +
          " does not fit in a " + LIMIT + "-character message",
      );
    }
    out.push(
      "Accounts " + (start + 1) + "-" + i + " of " + list.length + ":\n" + body,
    );
  }

  // Tail note on its own message when there is room for a useful one.
  const note =
    kind === "farm"
      ? "Your " + termWords(days) + " of automatic farming starts now" +
        (until ? " (until " + dayText(until) + ")" : "") +
        ". Keep the accounts linked and do not " +
        "change any passwords or emails. Details are in this offer's delivery " +
        "instructions."
      : kind === "unclaimed"
        ? "On Twitch open Drops & Rewards > Inventory: FIRST press Connect " +
          "and link your own game account, then press Claim on each drop. " +
          "Claim today - unclaimed drops expire days after the event. Full " +
          "steps are in this offer's delivery instructions."
        : "Log in on Twitch, open Drops & Rewards > Inventory, and press Connect " +
          "under each item to link it to your own game account. Full steps are in " +
          "this offer's delivery instructions.";
  out.push(note.slice(0, LIMIT));
  return out;
}

module.exports = {
  LIMIT,
  INSTRUCTION_LIMIT,
  clampInstruction,
  fit,
  credLine,
  credBlock,
  bundleDeliveryMessage,
  unclaimedDeliveryMessage,
  farmDeliveryMessage,
  deliveryMessages,
  bundleInstruction,
  unclaimedInstruction,
  farmInstruction,
};
