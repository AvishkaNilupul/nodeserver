// New farm bots must be created on the working local image. The first compose
// service is the template a new bot inherits from, and in 2026-09 that was the
// stale Docker Hub build — so every bot the auto-farm engine or the Bots page
// created came up watching without being credited. Only the local-only
// twitchbot-farm family may be inherited; anything else falls back to it.
const test = require("node:test");
const assert = require("node:assert");
const yaml = require("js-yaml");

const factory = require("../utils/botFactory");
const configRoutes = require("../routes/botConfigRoutes");

function compose(image) {
  return yaml.dump({
    services: {
      twitchbot: {
        image,
        container_name: "twitchbot",
        restart: "always",
        volumes: ["./config.json:/app/config.json"],
      },
    },
  });
}

function added(fn, raw) {
  const out = yaml.load(fn(raw, "twitchbotx7", "config_07.json").text);
  return out.services.twitchbotx7;
}

for (const [label, fn] of [
  ["botFactory", factory.addServiceToComposeText],
  ["botConfigRoutes", configRoutes.addServiceToComposeText],
]) {
  assert.strictEqual(typeof fn, "function", label + " must export addServiceToComposeText");

  test(label + ": a template on the stale Docker Hub build is never inherited", () => {
    const svc = added(fn, compose("avishkarex/twitchbot:latest"));
    assert.strictEqual(svc.image, "twitchbot-farm:latest");
  });

  test(label + ": a template on another local tag is not inherited either", () => {
    const svc = added(fn, compose("twitchbot-noclaim:latest"));
    assert.strictEqual(svc.image, "twitchbot-farm:latest");
  });

  test(label + ": a pinned twitchbot-farm tag is inherited", () => {
    const svc = added(fn, compose("twitchbot-farm:20260923"));
    assert.strictEqual(svc.image, "twitchbot-farm:20260923");
  });

  test(label + ": the new service reads its config where INSIDE_DOCKER looks", () => {
    const svc = added(fn, compose("twitchbot-farm:latest"));
    const env = [].concat(svc.environment || []).join(" ");
    assert.match(env, /INSIDE_DOCKER=true/);
    assert.ok(
      (svc.volumes || []).some((v) => v === "./config_07.json:/app/Configuration/config.json"),
      "config must be mounted at /app/Configuration/config.json, got " + JSON.stringify(svc.volumes),
    );
  });
}
