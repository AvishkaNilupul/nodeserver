function paginateArchiveItems(payload, query) {
  if (query.limit == null) return payload;

  const limit = Math.min(Math.max(Number(query.limit) || 80, 1), 200);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const total = payload.items.length;
  return {
    ...payload,
    items: payload.items.slice(offset, offset + limit),
    offset,
    limit,
    total,
    hasMore: offset + limit < total,
    truncated: payload.hasMore,
  };
}

module.exports = { paginateArchiveItems };
