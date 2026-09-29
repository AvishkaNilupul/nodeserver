/**
 * Disk-backed news store. Keeps every item we've ever seen (last 7 days) so
 * the feed doesn't shrink when the live cache expires or a source is briefly
 * unreachable.
 *
 * File: scripts/news-store.json (JSON array of NewsItems, gitignored).
 * On merge, live-fetched items overwrite persisted ones with the same id
 * (metrics grow, kind/store may improve as the classifier evolves).
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'news-store.json');
const RETENTION_DAYS = 7;
const SAVE_DEBOUNCE_MS = 5000;

const byId = new Map();
let saveTimer = null;
let loaded = false;

function load() {
  if (loaded) return;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const arr = JSON.parse(raw);
      const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
      for (const it of arr) {
        if (new Date(it.createdAt).getTime() >= cutoff) byId.set(it.id, it);
      }
    }
  } catch (err) {
    console.warn('news-store: failed to load,', err.message);
  }
  loaded = true;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const arr = [...byId.values()];
      fs.writeFileSync(STORE_PATH + '.tmp', JSON.stringify(arr));
      fs.renameSync(STORE_PATH + '.tmp', STORE_PATH);
    } catch (err) {
      console.warn('news-store: failed to save,', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  for (const [id, it] of byId) {
    if (new Date(it.createdAt).getTime() < cutoff) byId.delete(id);
  }
}

// Merge freshly-fetched items in. Live values overwrite persisted (metrics
// grow, classifier may reclassify). Returns the union — persisted + live,
// deduped, freshest first.
function merge(liveItems) {
  load();
  for (const it of liveItems) byId.set(it.id, it);
  prune();
  scheduleSave();
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function size() {
  load();
  return byId.size;
}

module.exports = { merge, size };
