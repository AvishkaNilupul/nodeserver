const USAGE_WINDOWS = new Set(["today", "7d", "30d", "all"]);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function usageSince(window, now = new Date(), requestedSince = "") {
  const key = USAGE_WINDOWS.has(window) ? window : "today";
  if (key === "all") return { key, since: null };
  const clientSince = requestedSince ? new Date(requestedSince) : null;
  if (clientSince && !Number.isNaN(clientSince.getTime())) return { key, since: clientSince };
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const startJst = new Date(jstNow);
  startJst.setUTCHours(0, 0, 0, 0);
  const days = key === "7d" ? 6 : key === "30d" ? 29 : 0;
  startJst.setUTCDate(startJst.getUTCDate() - days);
  return { key, since: new Date(startJst.getTime() - JST_OFFSET_MS) };
}

function usageGame(value) {
  const game = String(value || "").trim();
  return game || "(unspecified)";
}

function summarizeUsageRows(rows) {
  const games = new Map();
  let consumed = 0;
  let returned = 0;
  const returnedEvents = new Set(["released", "recycled", "returned", "sold"]);
  for (const row of rows || []) {
    const event = String(row._id?.event || "");
    const game = usageGame(row._id?.game);
    const count = Number(row.count) || 0;
    if (event === "claimed") consumed += count;
    if (returnedEvents.has(event)) returned += count;
    if (!games.has(game)) {
      games.set(game, {
        game,
        consumed: 0,
        farming: 0,
        recycled: 0,
        sold: 0,
        rented: 0,
        released: 0,
        byActor: {},
      });
    }
    const out = games.get(game);
    if (event === "claimed") {
      out.consumed += count;
      const actor = String(row._id?.actor || "unknown");
      out.byActor[actor] = (out.byActor[actor] || 0) + count;
    } else if (event === "recycled") out.recycled += count;
    else if (event === "sold") out.sold += count;
    else if (event === "rented") out.rented += count;
    else if (event === "released" || event === "returned") out.released += count;
  }
  const gameRows = [...games.values()]
    .map((g) => ({
      ...g,
      farming: Math.max(0, g.consumed - g.recycled - g.sold - g.released),
    }))
    .sort((a, b) => b.consumed - a.consumed || a.game.localeCompare(b.game));
  return { consumed, returned, net: consumed - returned, games: gameRows };
}

module.exports = { usageSince, usageGame, summarizeUsageRows };
