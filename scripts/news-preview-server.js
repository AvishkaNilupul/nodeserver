/**
 * Local news preview server — aggregates X + Reddit + Epic + CheapShark,
 * persists to disk (7-day retention), enriches drops items with a "farmable"
 * flag against the active-games list, exposes optional X SearchTimeline.
 *
 * Config: scripts/news-sources.json
 * Persistence: scripts/news-store.json (gitignored)
 * Usage:  node scripts/news-preview-server.js
 *         open http://localhost:4123
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const xAdapter = require('./adapters/x');
const redditAdapter = require('./adapters/reddit');
const epicAdapter = require('./adapters/epic');
const cheapsharkAdapter = require('./adapters/cheapshark');
const store = require('./news-store');
const { enrichFarmable } = require('./normalize');
const { searchAvailable } = require('./xClient');

const PORT = Number(process.env.NEWS_PREVIEW_PORT) || 4123;
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'news-sources.json'), 'utf8'));

// Cache TTLs — X is tightest (50/15min timeline quota). With 16 handles at
// 5min TTL we do ~48 calls per 15-min window, comfortably under 50.
const TTLS = {
  x:          5  * 60_000,
  reddit:     2  * 60_000,
  epic:       15 * 60_000,
  cheapshark: 5  * 60_000,
};

const cache = new Map();

async function cached(key, ttl, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return { ...hit, cached: true };
  const data = await loader();
  cache.set(key, { at: now, data });
  return { at: now, data, cached: false };
}

async function collect() {
  const [x, reddit, epic, cheap] = await Promise.all([
    cached('x',          TTLS.x,          () => xAdapter.fetchAll(CONFIG.x.handles, CONFIG.x.searches || [])),
    cached('reddit',     TTLS.reddit,     () => redditAdapter.fetchAll(CONFIG.reddit.subreddits)),
    cached('epic',       TTLS.epic,       () => epicAdapter.fetchAll()),
    cached('cheapshark', TTLS.cheapshark, () => cheapsharkAdapter.fetchAll()),
  ]);

  const live = [
    ...x.data.items,
    ...reddit.data.items,
    ...epic.data.items,
    ...cheap.data.items,
  ];

  const merged = store.merge(live);
  enrichFarmable(merged, CONFIG.drops?.activeGames || []);

  return {
    fetchedAt: new Date().toISOString(),
    items: merged,
    persistedTotal: store.size(),
    liveCount: live.length,
    sources: [
      sourceSummary('x',          x,     x.data.items.length,      x.data.errors),
      sourceSummary('reddit',     reddit, reddit.data.items.length, reddit.data.errors),
      sourceSummary('epic',       epic,  epic.data.items.length,   epic.data.errors),
      sourceSummary('cheapshark', cheap, cheap.data.items.length,  cheap.data.errors),
    ],
    xRateLimit: x.data.rateLimit || null,
    xSearchEnabled: searchAvailable(),
    activeGames: CONFIG.drops?.activeGames || [],
  };
}

function sourceSummary(name, entry, count, errors) {
  return {
    name,
    fetchedAt: new Date(entry.at).toISOString(),
    cached: entry.cached,
    count,
    errors: errors || [],
  };
}

const app = express();

app.get('/api/news', async (_req, res) => {
  try {
    const data = await collect();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'news-preview.html'));
});

app.listen(PORT, () => {
  console.log(`\nNews preview: http://localhost:${PORT}`);
  console.log(`API:           http://localhost:${PORT}/api/news`);
  console.log(`X handles:     ${CONFIG.x.handles.length}`);
  console.log(`X searches:    ${(CONFIG.x.searches || []).length}${searchAvailable() ? '' : ' (disabled — set X_QID_SEARCH_TIMELINE)'}`);
  console.log(`Subreddits:    ${CONFIG.reddit.subreddits.length}`);
  console.log(`Active games:  ${(CONFIG.drops?.activeGames || []).join(', ') || '(none)'}`);
  console.log(`Persisted:     ${store.size()} items on disk\n`);
});
