ARG DENO_VERSION=2.8.1

FROM denoland/deno:bin-${DENO_VERSION} AS deno

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY worker ./worker
COPY server ./server
COPY extension ./extension
COPY features ./features
COPY tests ./tests
COPY scripts ./scripts
RUN npx tsx scripts/build.ts
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /app

# 1. 复制 Deno 作为 YouTube Challenge 的 JavaScript 运行时
COPY --from=deno /deno /usr/local/bin/deno

# 2. 安装 ffmpeg、Python 及 yt-dlp 与 PO Token 插件 (bgutil-ytdlp-pot-provider)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages "yt-dlp[default]" "bgutil-ytdlp-pot-provider==1.3.1" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/cache && chown -R node:node /app/cache
USER node

ENV HOST=0.0.0.0
ENV PORT=8787
ENV CACHE_DIR=/app/cache
ENV TRANSLATION_AGENT_STORAGE=/app/cache/worker-storage.db

EXPOSE 8787
CMD ["node", "dist/server/src/server.js"]
