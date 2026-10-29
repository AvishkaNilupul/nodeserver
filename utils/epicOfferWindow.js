// Dates remain authoritative while Epic's cached promotion flags catch up.
function offerState(offer, now = Date.now()) {
  if (!offer || offer.active === false) return 'inactive';
  const start = offer.startDate == null ? null : new Date(offer.startDate).getTime();
  const end = offer.endDate == null ? null : new Date(offer.endDate).getTime();
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) return 'inactive';
  if (end !== null && end <= now) return 'expired';
  if (start !== null && start > now) return 'upcoming';
  if (offer.upcoming && start === null) return 'upcoming';
  return 'live';
}
function live(offer, now = Date.now()) { return offerState(offer, now) === 'live'; }
module.exports = { offerState, live };
