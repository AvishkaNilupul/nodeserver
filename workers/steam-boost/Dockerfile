FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.cjs ./
USER node
CMD ["node", "worker.cjs"]
