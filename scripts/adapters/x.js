/**
 * X adapter — fans out over configured handles + optional keyword searches.
 * SearchTimeline is only used when X_QID_SEARCH_TIMELINE is set in .env.local.
 */

const { fetchHandle, searchTweets, searchAvailable } = require('../xClient');

async function fetchAll(handles, searches = []) {
  const items = [];
  const errors = [];
  let rateLimit = null;

  const handleResults = await Promise.allSettled(
    handles.map(h => fetchHandle(h.name)),
  );
  for (let i = 0; i < handleResults.length; i++) {
    const r = handleResults[i];
    if (r.status === 'fulfilled') {
      items.push(...r.value.tweets);
      if (r.value.rateLimit) rateLimit = r.value.rateLimit;
    } else {
      errors.push({ handle: `@${handles[i].name}`, error: r.reason.message });
    }
  }

  if (searchAvailable() && searches.length) {
    const searchResults = await Promise.allSettled(
      searches.map(s => searchTweets(s.q)),
    );
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      if (r.status === 'fulfilled') {
        items.push(...r.value.tweets);
        if (r.value.rateLimit) rateLimit = r.value.rateLimit;
      } else {
        errors.push({ handle: `search:${searches[i].label}`, error: r.reason.message });
      }
    }
  }

  return { items, errors, rateLimit, searchEnabled: searchAvailable() };
}

module.exports = { fetchAll };
