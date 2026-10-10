/* global setInterval, clearInterval */
// Process RAM / CPU sampler for the SOOP panel's resource meter.
const os = require("os");

const MB = 1048576;
const round1 = (n) => Math.round(n * 10) / 10;

function createMetrics({ sampleMs = 5000, maxSamples = 240 } = {}) {
  const samples = [];
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  let timer = null;

  function sample() {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsed = Math.max(1, now - lastAt);
    lastCpu = process.cpuUsage();
    lastAt = now;
    samples.push({
      t: now,
      rssMB: round1(process.memoryUsage().rss / MB),
      cpu: round1(((cpu.user + cpu.system) / 1000 / elapsed) * 100),
    });
    if (samples.length > maxSamples) samples.shift();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(sample, sampleMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    view(sockets) {
      const m = process.memoryUsage();
      const last = samples[samples.length - 1];
      return {
        rssMB: round1(m.rss / MB),
        heapMB: round1(m.heapUsed / MB),
        cpuPct: last ? last.cpu : 0,
        sockets,
        freeMemMB: Math.round(os.freemem() / MB),
        totalMemMB: Math.round(os.totalmem() / MB),
        samples: samples.slice(),
      };
    },
  };
}

module.exports = { createMetrics };
