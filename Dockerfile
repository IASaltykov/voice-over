FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY test ./test
COPY tests ./tests
COPY config.toml README.md ./

RUN mkdir -p /app/input /app/output /app/logs /app/cache
VOLUME ["/app/input", "/app/output", "/app/logs", "/app/cache"]

ENTRYPOINT ["npx", "tsx", "src/main.mjs"]
