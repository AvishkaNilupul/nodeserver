function itemKeyFor(name, game) {
  return (
    String(name || "")
      .trim()
      .toLowerCase() +
    "|" +
    String(game || "")
      .trim()
      .toLowerCase()
  );
}

function mergeWaveItems(waves) {
  const byKey = new Map();
  for (const wave of waves || []) {
    for (const raw of wave.items || []) {
      const name = String(raw.name || "").trim();
      const game = String(raw.game || wave.game || "").trim();
      const itemKey = String(raw.itemKey || itemKeyFor(name, game)).trim();
      if (!name || !itemKey) continue;
      const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
      const current = byKey.get(itemKey);
      if (current) {
        current.qty += qty;
        if (!current.image && raw.image) current.image = raw.image;
        continue;
      }
      byKey.set(itemKey, {
        itemKey,
        name,
        game,
        image: String(raw.image || ""),
        qty,
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.game.localeCompare(b.game) || a.name.localeCompare(b.name),
  );
}

function eventListingNote(event, items) {
  const total = (items || []).reduce((sum, item) => sum + item.qty, 0);
  const lines = [
    event.game + " Twitch Drops from " + event.name + ".",
    "",
    "Includes " + total + " reward" + (total === 1 ? "" : "s") + ":",
  ];
  for (const item of items || []) {
    lines.push((item.qty > 1 ? item.qty + "x " : "") + item.name);
  }
  lines.push("");
  lines.push(
    "Stock is restricted to event-assigned farming accounts verified to hold the complete bundle.",
  );
  return lines.join("\n");
}

module.exports = { eventListingNote, itemKeyFor, mergeWaveItems };
