# Per-bot web-token farmer image for the Pi rig (mirrors the no-claim setup).
# Each bot runs one container: `--bot-config /config/config.json` farms that
# bot's accounts on its game via spade pings. No Mongo — the config file is the
# only input; the site reads live status separately.
FROM node:20-alpine

WORKDIR /app

# Only mongoose is declared; it's pulled in transitively by manager.js's Mongo
# store import even though bot-config mode never connects. Keeping it installed
# means the shared farmer code loads unchanged.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# The per-bot config.json is mounted read-only at /config by the runner.
CMD ["node", "src/index.js", "--bot-config", "/config/config.json"]
