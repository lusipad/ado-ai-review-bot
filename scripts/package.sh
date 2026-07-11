#!/usr/bin/env bash
# 一键打包（Linux / macOS / WSL / Git Bash）
#
#   ./scripts/package.sh              # 产出 release/ai-review-bot-<版本>-<平台>.tar.gz
#   ./scripts/package.sh --docker     # 额外产出 release/ai-review-bot-<版本>-docker.tar（离线镜像）
#   ./scripts/package.sh --skip-tests # 跳过测试（不推荐）
#
# 注意：tar.gz 里的 node_modules 含原生模块（better-sqlite3），
# 只能部署到与打包机相同的 OS/架构；跨平台请用 --docker 或在目标平台打包。
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_TESTS=0
WITH_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --docker) WITH_DOCKER=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
PLATFORM=$(node -p "process.platform + '-' + process.arch")
NAME="ai-review-bot-${VERSION}-${PLATFORM}"
RELEASE_DIR="$(pwd)/release"
mkdir -p "$RELEASE_DIR"

echo "==> [1/5] 安装依赖"
npm ci

echo "==> [2/5] 编译"
npm run build

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "==> [3/5] 运行测试"
  npm test
else
  echo "==> [3/5] 跳过测试"
fi

echo "==> [4/5] 组装部署目录"
STAGE_ROOT=$(mktemp -d)
trap 'rm -rf "$STAGE_ROOT"' EXIT
STAGE="$STAGE_ROOT/ai-review-bot"
mkdir -p "$STAGE"
cp -r dist prompts docs package.json package-lock.json .env.example "$STAGE/"
cp scripts/start.sh scripts/start.ps1 scripts/DEPLOY.md "$STAGE/"
chmod +x "$STAGE/start.sh"
# 只装生产依赖（在 stage 里重新 ci，保证干净）
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts=false >/dev/null)

echo "==> [5/5] 归档"
tar -czf "$RELEASE_DIR/$NAME.tar.gz" -C "$STAGE_ROOT" ai-review-bot
echo "    产出: release/$NAME.tar.gz"

if [ "$WITH_DOCKER" -eq 1 ]; then
  echo "==> [docker] 构建并导出离线镜像"
  docker build -t "ai-review-bot:$VERSION" .
  docker save -o "$RELEASE_DIR/ai-review-bot-${VERSION}-docker.tar" "ai-review-bot:$VERSION"
  echo "    产出: release/ai-review-bot-${VERSION}-docker.tar"
  echo "    内网机导入: docker load -i ai-review-bot-${VERSION}-docker.tar"
fi

echo ""
echo "✅ 打包完成。把 release/ 下的产物拷到部署机，解压后按包内 DEPLOY.md 操作。"
