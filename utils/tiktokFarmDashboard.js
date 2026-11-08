// Public dashboard fields only: never persist request headers or session material.
function parseRuntime(value) {
  if (!value || value.kind !== "android-api" || typeof value.instance !== "string" ||
      !/^[a-f0-9]{32}$/.test(value.instance) || typeof value.supervised !== "boolean") return null;
  const bounds = { uptimeSeconds: 366 * 86400, rssKiB: 16 * 1024 * 1024,
    peakRssKiB: 16 * 1024 * 1024, slots: 99 };
  if (Object.entries(bounds).some(([key, max]) => !Number.isSafeInteger(value[key]) ||
      value[key] < (key === "slots" ? 1 : 0) || value[key] > max)) return null;
  return Object.fromEntries(["kind", "instance", "supervised", ...Object.keys(bounds)].map((key) => [key, value[key]]));
}

function groupHosts(accounts) {
  const hosts = new Map();
  for (const account of accounts) {
    const runtime = account.runtime;
    if (!runtime) continue;
    let host = hosts.get(runtime.instance);
    if (!host) {
      host = { ...runtime, accounts: [], online: false };
      hosts.set(runtime.instance, host);
    }
    if (runtime.reportedAt > host.reportedAt) Object.assign(host, runtime);
    host.online ||= account.online;
    host.accounts.push(account.account);
  }
  return [...hosts.values()];
}

function summaryPipeline(now) {
  const stored = { $and: [{ $eq: ["$state", "completed"] }, { $eq: [{ $type: "$code" }, "string"] }] };
  return [{ $group: { _id: "$account", codes: { $sum: { $cond: [stored, 1, 0] } },
    claimed24h: { $sum: { $cond: [{ $and: [stored, { $gte: ["$updatedAt", new Date(now - 86400_000)] }] }, 1, 0] } },
    review: { $sum: { $cond: [{ $eq: ["$state", "review"] }, 1, 0] } },
    failed: { $sum: { $cond: [{ $eq: ["$state", "failed"] }, 1, 0] } },
    lastClaimAt: { $max: { $cond: [stored, "$updatedAt", null] } },
  } }];
}

module.exports = { parseRuntime, groupHosts, summaryPipeline };
