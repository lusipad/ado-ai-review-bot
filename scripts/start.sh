#!/usr/bin/env bash
# 部署包内的启动脚本（Linux）：读取同目录 .env 并启动服务
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "缺少 .env：请 cp .env.example .env 并填写必填项（见 DEPLOY.md）" >&2
  exit 1
fi

exec node --env-file=.env dist/server.js
