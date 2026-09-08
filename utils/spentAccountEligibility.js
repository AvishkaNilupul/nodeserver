// Pure eligibility rule for the manual spent-account review tab. The route
// gathers all facts in bulk; keeping this function DB-free makes every guard
// easy to test and keeps the write path fail-closed.
// The farm engines hand an account to the recycler by stamping its pool row
// with a "spent — …" claimedNote: "spent — no-claim removed <game>" from a
// no-claim bot sweep, "spent — unclaimed auto-listed (<reason>)" from the
// unclaimed auto-lister. Match the PREFIX, never one engine's wording — keying
// on a single engine's phrasing is what stranded every account the other
// engine sold: pulled from its bot, sold-game blocked, never recyclable.
const FARM_SPENT_NOTE = /^spent — /i;

function isFarmSpentNote(claimedNote) {
  return FARM_SPENT_NOTE.test(String(claimedNote || "").trim());
}

function cooldownPassedAt(newestDeliveredAt, cooldownDays, now) {
  if (!newestDeliveredAt) return false;
  const delivered = new Date(newestDeliveredAt).getTime();
  const current = new Date(now == null ? Date.now() : now).getTime();
  if (!Number.isFinite(delivered) || !Number.isFinite(current)) return false;
  const days = Math.max(0, Number(cooldownDays) || 0);
  return current - delivered >= days * 86400000;
}

function spentAccountEligibility(facts = {}) {
  const reject = (reason) => ({
    recyclable: false,
    reason,
    cooldownPassed: false,
  });
  const note = String(facts.claimedNote || "").trim();
  // Accounts handed over by a standalone farm engine — the no-claim bots or the
  // unclaimed auto-lister — carry a "spent — …" stamp on their pool row and
  // generally have NO DropLog history at all (they never entered the drop
  // archive). The stamp IS the delivery record: without this bypass they are
  // rejected forever on "no delivered drops" / "still has N drops left to
  // sell" / "within the 14-day cooldown", which strands them as claimed,
  // sold-game-blocked and un-recyclable.
  //
  // The DropLog counts genuinely say nothing about these accounts, so skipping
  // them is right — but that also means this branch has NO stock gate of its
  // own. What protects live stock is `onActiveListing`, which the caller must
  // compute from every record that can hold a sale: the marketplace listing
  // rows, the unclaimed engine's ledger, AND the pool row's `listed` flag.
  // Do NOT re-introduce a "connected" signal here as a spend test — a Twitch
  // account stays linked to Battle.net/Ubisoft forever, so it says nothing
  // about whether the stock is gone (it once flagged 153 healthy accounts).
  const farmSpent = !!facts.farmSpent;
  if (/^rented to/i.test(note)) return reject("rented to a renter");
  if (/^recycled/i.test(note)) return reject("already recycled");
  // `deployed` is computed from BotAccount.configFile, which is EMPTY for every
  // account that lives in a standalone no-claim container (those are tracked by
  // BotAccount.container instead) — so an account still inside a live bot config
  // reads as "not deployed" and gets offered for recycle. Two accounts were
  // sitting in noclaim-bot-6's config on the Pi while the tab listed them.
  // The pool row's own claim note is the reliable second signal: a row still
  // stamped "deployed to <container>" has not been handed over by any farm
  // engine (a handover rewrites the note to "spent — …"), so it is still in a
  // bot. Recycling it lets the auto-farmer deploy the same account a second
  // time — one account, two containers, which is exactly what dupeGuard exists
  // to prevent. Note that BotAccount.container is NOT usable here: it stays
  // stamped after the account is removed from the config, so it would block
  // every legitimate farm-spent row.
  if (/^deployed to /i.test(note)) {
    return reject("still in a bot config (pool row reads \"" + note + "\")");
  }
  // NOTE on `manualSold` (facts carry it; it is deliberately NOT a reject).
  // A hand-sold account carries exactly the risk this whole tab already accepts
  // for an automatically-sold one — the buyer holds the credentials either way —
  // so refusing only the hand-sold half would be inconsistent, and it would
  // strand the bulk of the queue. What the flag means is "sold, and no operator
  // has reviewed it since": the claim paths (noclaimFarmRoutes.readyPoolQuery,
  // autoFarmer.readyPoolQuery, the renter's pristine filter) all exclude it so a
  // sale can never quietly flow back into supply on its own. Clicking Recycle IS
  // that review, so the recycle write paths clear the flag; the row surfaces it
  // as a chip so the operator sees what they are letting back in.
  if ((Number(facts.availableDrops) || 0) > 0 && !farmSpent) {
    return reject("still has " + Number(facts.availableDrops) + " drop(s) left to sell");
  }
  if ((Number(facts.deliveredDrops) || 0) < 1 && !farmSpent) {
    return reject("no delivered drops");
  }
  if ((Number(facts.soldUnconnectedDrops) || 0) > 0) {
    return reject(
      "has " + Number(facts.soldUnconnectedDrops) + " sold drop(s) awaiting delivery",
    );
  }
  if (facts.onActiveListing) return reject("on an active marketplace listing");
  if (facts.deployed) return reject("still deployed to a bot");

  const passed = farmSpent
    ? true
    : cooldownPassedAt(facts.newestDeliveredAt, facts.cooldownDays, facts.now);
  return {
    recyclable: passed,
    reason: passed ? "" : "within the " + (Number(facts.cooldownDays) || 0) + "-day cooldown",
    cooldownPassed: passed,
  };
}

module.exports = {
  spentAccountEligibility,
  cooldownPassed: cooldownPassedAt,
  isFarmSpentNote,
  FARM_SPENT_NOTE,
};
