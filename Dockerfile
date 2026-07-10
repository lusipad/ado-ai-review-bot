# ---- build ----
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Codex CLI（内网环境如无法访问 npm registry，可改为 COPY 离线安装包）
RUN npm install -g @openai/codex

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY package.json ./

# codex 的模型配置：把宿主机的 config.toml 挂载到 /root/.codex/config.toml
# docker run -v ./codex-config.toml:/root/.codex/config.toml:ro ...
VOLUME ["/app/data", "/root/.codex"]

ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "dist/server.js"]
